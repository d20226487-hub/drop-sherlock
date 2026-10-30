"""Wayback Machine CDX Server API client.

Free, unauthenticated. Used to pull a list of snapshot crawl events for a
target URL — first/last seen, statuscode distribution, recent activity,
URL paths over time. The AI judge uses these to assess whether a dropped
domain has a healthy history (long-running site with mostly 200s) vs.
something that already 301'd away or only ever showed errors.

CDX docs: https://github.com/internetarchive/wayback/tree/master/wayback-cdx-server
Output format `output=json` returns a 2D array — first row is the column
header, subsequent rows are values. We post-process into normal dict rows
so the rest of the codebase (AI trim, table rendering) treats it like
every other criterion's response.

V2 page-content sampling (added 2026-05-07): `fetch_snapshot_page` pulls
the raw archived HTML for a `(timestamp, url)` pair via the `id_` raw-mode
modifier (`/web/{ts}id_/{url}`) — `id_` is critical, it bypasses Wayback's
toolbar+JS injection so the body we parse is the original document. We
then extract title + headings + a 150-char body excerpt with the stdlib
`html.parser` (no bs4 dep). Each call is independent of CDX so we can
batch a handful per domain without re-querying CDX.

Rate limits: Wayback throttles aggressively if you fan out. Defaults in
`app_settings._RATE_LIMIT_DEFAULTS["wayback"]` keep us conservative
(RPM 30 / max concurrent 2). Snapshot page fetches share the same
`wayback` rate-limit row — same host, same throttle bucket."""
from __future__ import annotations

import asyncio
import concurrent.futures
import random
import re
from html.parser import HTMLParser

import httpx

# Wayback rewrites Location headers on archived 3xx responses to point at
# archived versions of the destination — e.g. an original `Location:
# https://www.petsmart.com/` becomes `Location:
# https://web.archive.org/web/20210115182954id_/https://www.petsmart.com/`.
# For the AI judge + UI we want the bare destination, not the archive
# wrapper. Strip any `https?://web.archive.org/web/<digits>(id_)?/` prefix.
# Both `id_` (raw mode) and bare-timestamp variants exist in the wild.
_WAYBACK_WRAPPER_RE = re.compile(
    r"^https?://web\.archive\.org/web/\d+(?:id_|if_|cs_|js_|im_|css_)?/",
    re.IGNORECASE,
)


def _unwrap_archive_url(loc: str) -> str:
    return _WAYBACK_WRAPPER_RE.sub("", loc)

from ..app_settings import get_rate_limits
from .base import BaseProvider, ProviderError

API_BASE = "https://web.archive.org/cdx/search/cdx"
SNAPSHOT_BASE = "https://web.archive.org/web"

# Reactive throttle-cooldown gate (replaced the proactive burst gate on
# 2026-08-05). archive.org throttles by IP and the throttle lingers once
# tripped. The OLD gate unconditionally slept up to K=30s after every N=5
# requests — a FIXED tax that dominated wall-clock even on healthy batches
# (measured: a 20-domain V1+V2 run spent ~15 min, most of it gate sleeps,
# while archive.org was answering fine). Worse, it slept while HOLDING its
# lock, so a cooldown serialized ALL wayback traffic behind one sleeper and
# made max_concurrent>1 useless during the window.
#
# New model: back off ONLY after archive.org actually pushes back (HTTP 429 /
# 5xx / connect|read timeout). The offending coroutine ARMS a global cooldown;
# every wayback request waits out an armed cooldown before its next attempt,
# and the wait sleeps OUTSIDE the lock so healthy traffic is never serialized
# behind it. Same pattern the sibling wayback_sparkline gate already uses
# (_wait_for_cooldown / _arm_cooldown). State is process-global so one counter
# governs all wayback traffic uniformly — back-to-back jobs and concurrent
# users share the same breathing room against this free shared upstream.
_WB_COOLDOWN_S = 30.0
_wb_cooldown_lock = asyncio.Lock()
_wb_cooldown_until: float = 0.0  # event-loop monotonic time


async def _wb_wait_for_cooldown() -> None:
    """Block until any armed cooldown clears. Cheap fast-path when idle (a
    single monotonic-time comparison). Sleeps OUTSIDE the lock so concurrent
    waiters wake together without serializing through the gate. Called at the
    top of every CDX query AND every V2 snapshot fetch."""
    while True:
        now = asyncio.get_event_loop().time()
        if now >= _wb_cooldown_until:
            return
        await asyncio.sleep(_wb_cooldown_until - now)


async def _arm_cooldown(reason: str) -> None:
    """Arm the global cooldown to now + _WB_COOLDOWN_S, but only if it isn't
    already armed (caps the window instead of letting every sibling 429 extend
    it). Called when archive.org pushes back (429 / 5xx / network timeout)."""
    global _wb_cooldown_until
    import logging
    async with _wb_cooldown_lock:
        now = asyncio.get_event_loop().time()
        if _wb_cooldown_until <= now:
            _wb_cooldown_until = now + _WB_COOLDOWN_S
            logging.getLogger(__name__).info(
                "wayback cooldown armed for %.0fs (%s)",
                _WB_COOLDOWN_S, reason,
            )


# --- Egress selection (residential proxy pool, added 2026-08-11) ------------
# Imports are function-local: `wayback_proxies` pulls in app_settings +
# availability.webshare, and this module is imported from providers/__init__
# during runner startup — a module-level import risks a cycle.

# --- Internet Archive site-wide outage page (added 2026-08-11) -------------
# When the Archive is down for maintenance/incident, EVERY web.archive.org URL
# (CDX, /web/ replay, even the host root) returns a 503 whose body is their
# "Temporarily Offline" page — identical bytes regardless of target domain,
# snapshot age, URL modifier, User-Agent, or egress IP. Verified 2026-08-11.
#
# Treating that as a normal 5xx is actively wrong: it burns the whole retry
# budget on something no retry can fix, and arms cooldowns — which, with the
# residential pool, would mark perfectly good proxy IPs as throttled. Detect it
# and fail fast with a message that says what's actually happening.
_IA_OFFLINE_MSG = (
    "Internet Archive is temporarily offline — archive.org is serving its "
    "site-wide maintenance page for every request. Retrying will not help; "
    "wait for their services to return (check the Internet Archive's status "
    "accounts). Not a rate limit, a proxy problem, or a config error."
)


def _is_ia_offline(resp: httpx.Response, text: str | None = None) -> bool:
    """True when this 503 is the Archive's global maintenance page rather than
    a real per-request server error. Deliberately narrow: 503 + HTML +the
    page's own wording, so a genuine 503 from a busy backend still retries.

    `text` lets a STREAMED caller pass the body it already read — a
    streamed response has no `.text` until fully read, and the snapshot
    path deliberately never reads it fully. CDX passes nothing and keeps
    using `resp.text`, unchanged."""
    if resp.status_code != 503:
        return False
    if "html" not in (resp.headers.get("content-type") or "").lower():
        return False
    try:
        body = text if text is not None else resp.text
        return "temporarily offline" in body[:4000].lower()
    except Exception:  # noqa: BLE001
        return False


async def _read_capped(resp: httpx.Response, limit: int) -> tuple[bytes, bool]:
    """Read at most `limit` decoded bytes from a STREAMED response.

    Returns (data, truncated). `truncated` means we hit the cap and stopped
    reading — the rest of the body is never pulled, and leaving the
    `client.stream()` block closes the connection instead of draining it.
    """
    buf = bytearray()
    async for chunk in resp.aiter_bytes():
        room = limit - len(buf)
        if len(chunk) >= room:
            buf.extend(chunk[:room])
            return bytes(buf), True
        buf.extend(chunk)
    return bytes(buf), False


def _decode_body(resp: httpx.Response, data: bytes) -> str:
    """Decode exactly as httpx 0.28's `Response.text` would have.

    Our clients never set `default_encoding`, so it is the string "utf-8",
    which means `resp.encoding` resolves WITHOUT needing the body: the
    Content-Type charset when present and known, else UTF-8. httpx then
    decodes with errors="replace". Matching that precisely matters — the
    operator's .kz/.ru drops are Cyrillic, and a different fallback would
    change what language detection sees.

    A cap landing mid-way through a multi-byte character yields one U+FFFD
    at the very end, which is harmless.
    """
    if not data:
        return ""
    return data.decode(resp.encoding or "utf-8", errors="replace")


def _acquire_egress(phase: str):
    """`(client_or_None, egress_key)` for this phase. `None` = go direct."""
    from .. import wayback_proxies
    return wayback_proxies.acquire(phase)


async def _note_throttle(egress: str, reason: str) -> None:
    """Route a push-back signal to the right cooldown.

    Direct egress arms the GLOBAL gate — correct when every request shares one
    server IP. A proxy egress cools down ONLY that IP: pausing all N proxies
    because one was throttled would defeat the entire point of rotating."""
    from .. import wayback_proxies
    if egress == wayback_proxies.DIRECT:
        await _arm_cooldown(reason)
    else:
        wayback_proxies.report_throttle(egress)
# Cap per-snapshot extracted text so a single bloated archived page can't
# blow up the AI prompt or the persisted JSON. Body excerpt is also capped
# downstream (150 chars) but headings can repeat — limit each list length.
_MAX_HEADINGS_PER_LEVEL = 12
# Whitespace-collapsed body excerpt length. Raised 150 -> 300 (2026-10-30):
# the first ~150 characters of a page body are very often navigation
# boilerplate ("Home | About | Contact | Login ..."), so the excerpt said
# little about the site. It feeds the Wayback AI judge, the classifier's
# AI prompt, and library-mode language detection (lingua), which is
# noticeably more reliable on longer text.
#
# Deliberately NOT part of the Wayback data cache key: putting it there
# would force every already-analysed domain to re-download its samples
# from archive.org. Domains cached before this change keep their
# 150-character excerpts until re-analysed without the cache.
_BODY_EXCERPT_CHARS = 300
# Hard cap on how much of an archived page V2 downloads (2026-10-30).
#
# The download used to buffer the WHOLE body (`client.get` + `r.text`).
# `id_` mode replays the original archived bytes, so a parked or spam
# domain's root can be a multi-megabyte keyword-stuffed page, and a
# redirect target can turn out to be a binary. Every byte landed in RAM,
# then again on decode — roughly doubling for Cyrillic, which CPython
# stores at 2 bytes/char. With several downloads in flight and glibc
# keeping the high-water mark instead of returning memory, a long Wayback
# run ratcheted the API up until the deployment server ran out and
# rebooted.
#
# 2 MB is generous for what we actually use: title, `lang`, up to
# _MAX_HEADINGS_PER_LEVEL headings per level and a _BODY_EXCERPT_CHARS
# excerpt — all of which live at the TOP of a page. A capped page loses
# only headings deep in an enormous document.
#
# Applies to DECODED bytes (`aiter_bytes`), so it also bounds a gzip
# response by its expanded size, not its wire size.
_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024
# A 503 body is only read to recognise the Archive's maintenance page,
# which needs its first ~4 KB; never pull a large body for that.
_OFFLINE_PROBE_BYTES = 16 * 1024

# Dedicated thread pool for HTML parsing (2026-10-30).
#
# The API runs as ONE uvicorn worker, so a single event loop serves every
# page request AND every running job. Parsing an archived page is
# CPU-bound pure Python; done inline in the async fetch, it froze that
# loop for its whole duration, so page requests queued behind a Wayback
# run until Cloudflare gave up after 100 s and returned a 524 — which
# looked to the operator like the server rebooting.
#
# Why a dedicated pool rather than `asyncio.to_thread`: html.parser holds
# the GIL, so parse threads never run in parallel and extra threads add no
# throughput. What a thread buys is letting the event loop take turns on
# the GIL — and the fewer parse threads compete, the larger the loop's
# share, so requests stay responsive. It also keeps a burst of parses off
# the loop's default executor, which the job runner uses for its database
# writes.
_PARSE_POOL = concurrent.futures.ThreadPoolExecutor(
    max_workers=2, thread_name_prefix="wb-parse",
)
# HTML elements whose text content should not contribute to ANY extracted
# field — they're non-visible noise (scripts, styles) we never want.
# Note: `<head>` is deliberately NOT in this set even though we don't want
# meta-text in the body excerpt: `<title>` lives inside `<head>`, and
# blanket-skipping head text suppresses the title before the per-tag
# title accumulator can pick it up. The body-excerpt collection is gated
# separately below to keep head content out of the prose excerpt.
_SKIP_TEXT_TAGS = frozenset(
    {"script", "style", "noscript", "template"}
)


def _backoff(attempt: int) -> float:
    base = min(30.0, 2 ** attempt)
    jitter = random.uniform(0.75, 1.25)
    return base * jitter


class _SnapshotHTMLParser(HTMLParser):
    """Single-pass HTML extractor for archived snapshot pages.

    Pulls `<title>`, all `<h1>`/`<h2>`/`<h3>`, and a body-text excerpt.
    Skips text inside `<script>` / `<style>` / `<noscript>` / `<template>`
    / `<head>` so the body excerpt reflects visible prose.

    Stops accumulating body text once we've collected enough characters
    for the excerpt to keep parsing cheap on large pages."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        # `<html lang="...">` value, lowercased, stripped to the base
        # language code only ('en-US' → 'en'). Empty when not present.
        # Used by wayback_classify (added 2026-05-09) as a high-signal
        # hint for AI-mode language detection.
        self.lang_attr = ""
        self.h1s: list[str] = []
        self.h2s: list[str] = []
        self.h3s: list[str] = []
        # Buffer for the next-completed text-collecting tag (title/h1/h2/h3).
        # When the tag closes we move it to the right list.
        self._tag_stack: list[str] = []
        self._heading_buf = ""
        self._in_heading: str | None = None
        self._in_title = False
        # Body excerpt: collect text from any tag we don't actively skip,
        # up to _BODY_EXCERPT_CHARS * 4 raw chars (we'll collapse whitespace
        # at the end). Multiplier gives headroom for stripping.
        self._body_chars: list[str] = []
        self._body_budget = _BODY_EXCERPT_CHARS * 4

    def handle_starttag(self, tag: str, attrs: list) -> None:
        self._tag_stack.append(tag)
        if tag == "html" and not self.lang_attr:
            for k, v in attrs:
                if k == "lang" and isinstance(v, str) and v.strip():
                    # Take the base language sub-tag only — 'en-US' → 'en',
                    # 'pt-BR' → 'pt'. Region/script tags are noise for
                    # downstream filtering.
                    base = v.strip().lower().split("-", 1)[0]
                    if base.isalpha() and 2 <= len(base) <= 3:
                        self.lang_attr = base
                    break
        if tag == "title":
            self._in_title = True
            self._heading_buf = ""
        elif tag in ("h1", "h2", "h3"):
            self._in_heading = tag
            self._heading_buf = ""

    def handle_endtag(self, tag: str) -> None:
        if self._tag_stack and self._tag_stack[-1] == tag:
            self._tag_stack.pop()
        if tag == "title" and self._in_title:
            self._in_title = False
            self.title = self._heading_buf.strip()
            self._heading_buf = ""
        elif tag in ("h1", "h2", "h3") and self._in_heading == tag:
            text = self._heading_buf.strip()
            if text:
                target = {
                    "h1": self.h1s, "h2": self.h2s, "h3": self.h3s,
                }[tag]
                if len(target) < _MAX_HEADINGS_PER_LEVEL:
                    target.append(text)
            self._in_heading = None
            self._heading_buf = ""

    def handle_data(self, data: str) -> None:
        # Skip text under non-content tags (script/style/etc.) entirely —
        # walk the active tag stack and bail if any ancestor is suppressed.
        for ancestor in self._tag_stack:
            if ancestor in _SKIP_TEXT_TAGS:
                return
        if self._in_title or self._in_heading:
            self._heading_buf += data
        # Body excerpt: only collect text that's actually inside <body>
        # (or that appears outside <head>, for old HTML without an explicit
        # body tag). Skipping when "head" is in the active stack keeps
        # title/meta noise out of the prose excerpt.
        if self._body_budget > 0 and "head" not in self._tag_stack:
            chunk = data[: self._body_budget]
            self._body_chars.append(chunk)
            self._body_budget -= len(chunk)

    @property
    def body_excerpt(self) -> str:
        """Whitespace-collapsed first ~150 chars of body text."""
        raw = "".join(self._body_chars)
        # Collapse runs of whitespace to single spaces so multi-line
        # archived markup doesn't waste characters.
        collapsed = " ".join(raw.split())
        if len(collapsed) > _BODY_EXCERPT_CHARS:
            return collapsed[:_BODY_EXCERPT_CHARS].rstrip() + "…"
        return collapsed


def parse_snapshot_html(html: str) -> dict:
    """Run `_SnapshotHTMLParser` over a single archived page's HTML.

    Returns `{title, h1s, h2s, h3s, body_excerpt}`. Caller handles fetch
    errors (HTTP status, network) — this only deals with parsing."""
    parser = _SnapshotHTMLParser()
    try:
        parser.feed(html)
        parser.close()
    except Exception:  # noqa: BLE001
        # html.parser is forgiving but pathological input (e.g. truncated
        # binary) can still raise. Return whatever we got partially.
        pass
    return {
        "title": parser.title,
        "h1s": parser.h1s,
        "h2s": parser.h2s,
        "h3s": parser.h3s,
        "body_excerpt": parser.body_excerpt,
        # Empty string when the HTML had no <html lang="..."> attribute.
        # Always lowercase ISO 639-1 (or 639-3) base — region tag stripped.
        "lang_attr": parser.lang_attr,
    }


class WaybackClient(BaseProvider):
    name = "wayback"
    # CDX queries against high-history domains (e.g. geocities.com) routinely
    # take 30–60s — Wayback's pre-V3 CDX backend is slow on full-domain
    # `matchType=domain` scans. The default 20s base timeout was tripping
    # network-error-after-retries on legitimate domains (caught 2026-05-07).
    # 90s read with a 15s connect cap matches what curl `--max-time 90` does
    # in practice. Snapshot page fetches reuse this client too — those are
    # smaller responses but the server still occasionally takes >20s under
    # load, so the same generous timeout is appropriate.
    timeout = httpx.Timeout(90.0, connect=15.0)

    async def test_credentials(self) -> dict:
        """Wayback has no creds — sanity-check by hitting CDX with a
        tiny query against archive.org itself. Returns ok if 2xx."""
        url = (
            f"{API_BASE}?url=archive.org&limit=1&output=json"
            f"&fl=urlkey,timestamp,statuscode"
        )
        try:
            r = await self.client.get(url)
        except Exception as e:  # noqa: BLE001
            raise ProviderError(f"network error: {e}") from e
        if r.status_code >= 400:
            raise ProviderError(
                f"Wayback CDX returned {r.status_code}: {r.text[:200]}"
            )
        return {"ok": True, "provider": "wayback"}

    async def fetch_url(
        self, url: str, *, phase: str = "v1"
    ) -> tuple[int, dict, dict]:
        """Issue a GET against an already-built CDX URL. Returns
        (http_status, json_body, units). `units` is always empty for
        Wayback (no metered quota), but the tuple shape matches AhrefsClient
        so the runner can call them through the same path.

        Wayback returns a 2D array: `[[col1,col2,...], [v1,v2,...], ...]`.
        We unwrap into `{"wayback": [{col1: v1, ...}, ...]}` so downstream
        code (row count, AI trim, table render) sees the same shape every
        other criterion uses."""
        retry_max = get_rate_limits("wayback").get("retry_max", 3)
        last_exc: Exception | None = None
        for attempt in range(retry_max + 1):
            # Re-acquired per ATTEMPT so a retry lands on a different
            # residential IP — that rotation is the recovery mechanism, since
            # the usual reason an attempt failed is that its egress IP was
            # throttled.
            client, egress = _acquire_egress(phase)
            if client is None:
                client = self.client
                # Only the shared server IP waits on the global gate; proxies
                # carry their own per-IP cooldowns.
                await _wb_wait_for_cooldown()
            try:
                r = await client.get(url)
            except Exception as e:  # noqa: BLE001
                last_exc = e
                # Network/timeout == this egress IP is being tarpitted.
                await _note_throttle(egress, f"network {type(e).__name__}")
                if attempt < retry_max:
                    await asyncio.sleep(_backoff(attempt))
                    continue
                # Surface a more actionable message: timeouts on CDX are
                # almost always "limit too high for this domain's history,"
                # not a real network outage.
                hint = ""
                if isinstance(e, (httpx.ReadTimeout, httpx.ConnectTimeout)):
                    hint = (
                        " — Wayback CDX timed out. Try lowering `limit` or "
                        "narrowing the year range; large-history domains "
                        "(e.g. geocities.com) need either."
                    )
                raise ProviderError(
                    f"network error after {retry_max + 1} attempts: "
                    f"{type(e).__name__}: {e}{hint}"
                ) from e

            if r.status_code == 429 or 500 <= r.status_code < 600:
                # Archive-wide outage: bail immediately. No retry can fix it,
                # and arming a cooldown would blame our IP/proxies for it.
                if _is_ia_offline(r):
                    raise ProviderError(_IA_OFFLINE_MSG)
                await _note_throttle(egress, f"http {r.status_code}")
                if attempt < retry_max:
                    await asyncio.sleep(_backoff(attempt))
                    continue
                raise ProviderError(
                    f"Wayback returned {r.status_code} after "
                    f"{retry_max + 1} attempts: {r.text[:200]}"
                )

            if r.status_code >= 400:
                raise ProviderError(
                    f"Wayback returned {r.status_code}: {r.text[:200]}"
                )

            try:
                arr = r.json()
            except ValueError:
                # Empty body is normal for "no snapshots found" — return
                # an empty list rather than failing.
                arr = []
            rows: list[dict] = []
            if isinstance(arr, list) and len(arr) >= 1:
                # First row is the header. Subsequent rows are values.
                header = arr[0] if isinstance(arr[0], list) else []
                for row in arr[1:]:
                    if not isinstance(row, list):
                        continue
                    rec: dict = {}
                    for i, key in enumerate(header):
                        rec[key] = row[i] if i < len(row) else None
                    rows.append(rec)
            return r.status_code, {"wayback": rows}, {}

        raise ProviderError(f"unreachable: retry exhausted ({last_exc!r})")

    async def fetch_snapshot_page(
        self, *, timestamp: str, url: str, phase: str = "v2"
    ) -> dict:
        """Fetch an archived HTML page and extract title + headings + body.

        Returns a sample dict the runner can stash into
        `CriterionResult.data_json.samples`:

            {
              "timestamp": "20180515123456",
              "url": "https://example.com/about",
              "snapshot_url": "https://web.archive.org/web/20180515123456id_/...",
              "http_status": 200,
              "title": "...", "h1s": [...], "h2s": [...], "h3s": [...],
              "body_excerpt": "..."
            }

        On non-2xx or network error returns the same shape with empty
        text fields and an `error` key — callers keep going so a partial
        sample list is still useful. We deliberately do NOT raise here:
        page samples are best-effort enrichment on top of CDX rows.

        The `id_` raw-mode modifier (`/web/{ts}id_/{url}`) is critical —
        without it Wayback injects their toolbar + JS shim into the
        response, polluting the HTML. With `id_` we get the original
        archived bytes.
        """
        snapshot_url = f"{SNAPSHOT_BASE}/{timestamp}id_/{url}"
        # V2 snapshots read their retry budget from the dedicated
        # `wayback_snapshot` row (see app_settings), independent of V1 CDX.
        retry_max = get_rate_limits("wayback_snapshot").get("retry_max", 3)
        last_exc: Exception | None = None

        def _empty(http_status: int, error: str | None = None) -> dict:
            out: dict = {
                "timestamp": timestamp,
                "url": url,
                "snapshot_url": snapshot_url,
                "http_status": http_status,
                "title": "",
                "h1s": [],
                "h2s": [],
                "h3s": [],
                "body_excerpt": "",
                "lang_attr": "",
                "redirect_to": "",
            }
            if error:
                out["error"] = error
            return out

        for attempt in range(retry_max + 1):
            # Same per-attempt rotation as CDX — a retry gets a fresh IP.
            client, egress = _acquire_egress(phase)
            if client is None:
                client = self.client
                await _wb_wait_for_cooldown()
            try:
                # STREAMED, not `client.get()` — that buffered the whole
                # archived page. Bodies are read only where they're used:
                # 2xx (to parse, capped) and 503 (offline probe, tiny).
                # 3xx needs just the Location header; other errors need
                # nothing. A failure mid-body is a network error like any
                # other, so the read sits inside this same try.
                body_text = ""
                truncated = False
                offline = False
                async with client.stream("GET", snapshot_url) as r:
                    status = r.status_code
                    headers = r.headers
                    if 200 <= status < 300:
                        data, truncated = await _read_capped(
                            r, _SNAPSHOT_MAX_BYTES
                        )
                        body_text = _decode_body(r, data)
                    elif status == 503:
                        data, _ = await _read_capped(r, _OFFLINE_PROBE_BYTES)
                        offline = _is_ia_offline(r, _decode_body(r, data))
            except Exception as e:  # noqa: BLE001
                last_exc = e
                await _note_throttle(egress, f"network {type(e).__name__}")
                if attempt < retry_max:
                    await asyncio.sleep(_backoff(attempt))
                    continue
                return _empty(0, error=f"network: {e}")

            # Throttle / server errors get the same retry treatment as CDX.
            if status == 429 or 500 <= status < 600:
                # Archive-wide outage — same fast-fail as CDX. Samples are
                # best-effort, so this returns rather than raising.
                if offline:
                    return _empty(status, error=_IA_OFFLINE_MSG)
                await _note_throttle(egress, f"http {status}")
                if attempt < retry_max:
                    await asyncio.sleep(_backoff(attempt))
                    continue
                return _empty(
                    status,
                    error=f"http {status} after retries",
                )

            if status >= 400:
                # 404 here usually means archive.org doesn't have a usable
                # snapshot at that exact (ts, url). Surface but don't retry.
                return _empty(status, error=f"http {status}")

            # 3xx: the original site served a redirect at this snapshot.
            # We deliberately don't follow (`follow_redirects=False` is the
            # base default) — the redirect tail itself is the meaningful
            # signal for the AI. Parsing the body would just capture
            # Apache's stock "Moved Temporarily" stub, which adds prompt
            # noise without new info. Instead surface the `Location`
            # header as a structured `redirect_to` field so the AI can
            # reason about migration targets cleanly.
            if 300 <= status < 400:
                location = headers.get("location") or headers.get("Location") or ""
                out = _empty(status)
                out["redirect_to"] = _unwrap_archive_url(location.strip())
                return out

            # Off the event loop — see _PARSE_POOL.
            parsed = await asyncio.get_running_loop().run_in_executor(
                _PARSE_POOL, parse_snapshot_html, body_text,
            )
            out = {
                "timestamp": timestamp,
                "url": url,
                "snapshot_url": snapshot_url,
                "http_status": status,
                "redirect_to": "",
                **parsed,
            }
            # Persisted for debugging only ("why so few headings?"). The
            # prompt builder and classifier read samples by explicit key,
            # so this never reaches the AI or changes a verdict.
            if truncated:
                out["truncated"] = True
            return out

        # Retry exhausted with `last_exc` set.
        return _empty(0, error=f"unreachable: {last_exc!r}")
