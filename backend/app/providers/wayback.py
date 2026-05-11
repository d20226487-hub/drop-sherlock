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

# Burst-cooldown gate. CDX has its own sliding throttle window that the
# token-bucket rate limiter doesn't fully account for: even at RPM=30 +
# concurrent=1, sustained traffic during long batches (>20 domains) hits
# Wayback's window and produces cascading ConnectTimeouts. Enforce a
# minimum total elapsed time per burst — if a burst of N fetches ran
# faster than K seconds, sleep the difference before the next burst.
#
# When CDX is naturally slow (10–30s per response), the burst already
# exceeds K and no extra sleep happens. When CDX is responsive and we'd
# otherwise saturate it, the cooldown spaces things out.
#
# `_WB_BURST_SIZE = 5` and `_WB_BURST_COOLDOWN_S = 30` are chosen empirically
# from the 31/35-fail incident on 2026-05-07: the bursts started failing
# around request #6, and recovery took ~30s of silence in observed retries.
# State is process-global — carries between jobs, which is desirable:
# back-to-back jobs benefit from the same breathing room.
# Multi-user implication (LAN deploy): if user A's job triggers the
# cooldown, user B's job inherits the wait. This is acceptable because
# Wayback CDX is a free shared upstream — both users hammering it
# independently is what triggered the original incident, and the gate
# protecting both via one counter is the whole point. If you ever need
# per-user fairness, key the state by job_id (but expect the upstream
# to push back when concurrent bursts collide).
_WB_BURST_SIZE = 5
_WB_BURST_COOLDOWN_S = 30.0
_wb_burst_lock = asyncio.Lock()
_wb_burst_state: dict[str, float] = {"count": 0, "burst_start_at": 0.0}


async def _wb_burst_gate() -> None:
    """Enforce 'burst N then cool down K seconds' on the wayback HTTP path.
    Called at the top of every CDX query AND every V2 snapshot fetch so
    one counter governs all wayback traffic uniformly. Cooldown duration
    measured from the START of the current burst, not from the previous
    cooldown — that way a slow burst doesn't accidentally double-pause."""
    import logging
    async with _wb_burst_lock:
        _wb_burst_state["count"] += 1
        if _wb_burst_state["count"] == 1:
            _wb_burst_state["burst_start_at"] = (
                asyncio.get_event_loop().time()
            )
        if _wb_burst_state["count"] > _WB_BURST_SIZE:
            loop = asyncio.get_event_loop()
            burst_duration = loop.time() - _wb_burst_state["burst_start_at"]
            if burst_duration < _WB_BURST_COOLDOWN_S:
                wait = _WB_BURST_COOLDOWN_S - burst_duration
                logging.getLogger(__name__).info(
                    "wayback burst-cooldown: pausing %.1fs "
                    "(burst of %d fetches took %.1fs, target %.1fs)",
                    wait, _WB_BURST_SIZE, burst_duration,
                    _WB_BURST_COOLDOWN_S,
                )
                await asyncio.sleep(wait)
            _wb_burst_state["count"] = 1
            _wb_burst_state["burst_start_at"] = (
                asyncio.get_event_loop().time()
            )
# Cap per-snapshot extracted text so a single bloated archived page can't
# blow up the AI prompt or the persisted JSON. Body excerpt is also capped
# downstream (150 chars) but headings can repeat — limit each list length.
_MAX_HEADINGS_PER_LEVEL = 12
_BODY_EXCERPT_CHARS = 150
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

    async def fetch_url(self, url: str) -> tuple[int, dict, dict]:
        """Issue a GET against an already-built CDX URL. Returns
        (http_status, json_body, units). `units` is always empty for
        Wayback (no metered quota), but the tuple shape matches AhrefsClient
        so the runner can call them through the same path.

        Wayback returns a 2D array: `[[col1,col2,...], [v1,v2,...], ...]`.
        We unwrap into `{"wayback": [{col1: v1, ...}, ...]}` so downstream
        code (row count, AI trim, table render) sees the same shape every
        other criterion uses."""
        await _wb_burst_gate()
        retry_max = get_rate_limits("wayback").get("retry_max", 3)
        last_exc: Exception | None = None
        for attempt in range(retry_max + 1):
            try:
                r = await self.client.get(url)
            except Exception as e:  # noqa: BLE001
                last_exc = e
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
        self, *, timestamp: str, url: str
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
        await _wb_burst_gate()
        snapshot_url = f"{SNAPSHOT_BASE}/{timestamp}id_/{url}"
        retry_max = get_rate_limits("wayback").get("retry_max", 3)
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
            try:
                r = await self.client.get(snapshot_url)
            except Exception as e:  # noqa: BLE001
                last_exc = e
                if attempt < retry_max:
                    await asyncio.sleep(_backoff(attempt))
                    continue
                return _empty(0, error=f"network: {e}")

            # Throttle / server errors get the same retry treatment as CDX.
            if r.status_code == 429 or 500 <= r.status_code < 600:
                if attempt < retry_max:
                    await asyncio.sleep(_backoff(attempt))
                    continue
                return _empty(
                    r.status_code,
                    error=f"http {r.status_code} after retries",
                )

            if r.status_code >= 400:
                # 404 here usually means archive.org doesn't have a usable
                # snapshot at that exact (ts, url). Surface but don't retry.
                return _empty(r.status_code, error=f"http {r.status_code}")

            # 3xx: the original site served a redirect at this snapshot.
            # We deliberately don't follow (`follow_redirects=False` is the
            # base default) — the redirect tail itself is the meaningful
            # signal for the AI. Parsing the body would just capture
            # Apache's stock "Moved Temporarily" stub, which adds prompt
            # noise without new info. Instead surface the `Location`
            # header as a structured `redirect_to` field so the AI can
            # reason about migration targets cleanly.
            if 300 <= r.status_code < 400:
                location = r.headers.get("location") or r.headers.get("Location") or ""
                out = _empty(r.status_code)
                out["redirect_to"] = _unwrap_archive_url(location.strip())
                return out

            parsed = parse_snapshot_html(r.text)
            return {
                "timestamp": timestamp,
                "url": url,
                "snapshot_url": snapshot_url,
                "http_status": r.status_code,
                "redirect_to": "",
                **parsed,
            }

        # Retry exhausted with `last_exc` set.
        return _empty(0, error=f"unreachable: {last_exc!r}")
