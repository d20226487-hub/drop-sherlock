"""Coverage for the 2 MB cap on Wayback V2 archived-page downloads
(added 2026-10-30).

The download used to buffer the WHOLE archived page (`client.get` +
`r.text`). On the deployment server a long Wayback run ratcheted the API's
memory up until the machine ran out and rebooted. These tests pin that:

  * a huge page is read only up to the cap, and the headers we actually
    use (title, lang, headings) still come through;
  * bodies are read ONLY where needed — never for 3xx/4xx, and only a
    small probe for a 503;
  * decoding is byte-for-byte what httpx's `.text` produced before, so
    Cyrillic pages keep feeding language detection the same text;
  * retry / offline / network-error behaviour is unchanged.

Bodies are lazy async iterators that record how many bytes the client
actually pulled — the honest measure of whether the cap holds.
"""
from __future__ import annotations

import asyncio
import gzip
import os
import tempfile
import threading
import time
from pathlib import Path

import httpx
import pytest

# A temp FILE, not :memory: — the app's engine passes pool_size /
# max_overflow, which SQLite's in-memory SingletonThreadPool rejects. Same
# shape the other test modules use. setdefault so the container suite's
# own fixtures still win.
os.environ.setdefault(
    "DATABASE_URL",
    "sqlite:///" + (Path(tempfile.gettempdir()) / "wb_cap_test.db").as_posix(),
)

CAP = 2 * 1024 * 1024
PROBE = 16 * 1024
HEAD = (
    b'<html lang="ru"><head><title>Probe Title</title></head>'
    b"<body><h1>Main Heading</h1><p>Hello body text "
)


class Body:
    """Lazy async body: yields `head` then filler up to `total` bytes,
    recording how much the client pulled. `fail_after` raises a network
    error part-way through, like a dropped connection."""

    def __init__(self, head=b"", total=0, chunk=64 * 1024, filler=b"x",
                 fail_after=None):
        self.head = head
        self.total = total
        self.chunk = chunk
        self.filler = filler
        self.fail_after = fail_after
        self.pulled = 0

    async def _gen(self):
        rest = self.head
        while self.pulled < self.total:
            if self.fail_after is not None and self.pulled >= self.fail_after:
                raise httpx.ReadError("connection dropped mid-body")
            if rest:
                piece, rest = rest[: self.chunk], rest[self.chunk:]
            else:
                piece = self.filler * self.chunk
            piece = piece[: self.total - self.pulled]
            self.pulled += len(piece)
            yield piece

    def __aiter__(self):
        return self._gen()


@pytest.fixture
def wb(monkeypatch):
    """The wayback module with everything that would touch the DB, the
    proxy pool, or the 30-second global cooldown stubbed out."""
    from app.providers import wayback as wb

    async def _noop(*_a, **_k):
        return None

    monkeypatch.setattr(wb, "get_rate_limits", lambda _name: {"retry_max": 2})
    monkeypatch.setattr(wb, "_acquire_egress", lambda _phase: (None, "direct"))
    monkeypatch.setattr(wb, "_note_throttle", _noop)
    monkeypatch.setattr(wb, "_backoff", lambda _attempt: 0)
    monkeypatch.setattr(wb, "_wb_cooldown_until", 0.0)
    return wb


def _fetch(wb, handler):
    async def run():
        p = wb.WaybackClient()
        p._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        try:
            return await p.fetch_snapshot_page(
                timestamp="20200101000000", url="http://example.kz/",
            )
        finally:
            await p._client.aclose()
    return asyncio.run(run())


# --- the cap itself --------------------------------------------------------


def test_huge_page_is_capped_but_still_parsed(wb):
    bodies = []

    def handler(_req):
        b = Body(HEAD, total=50 * 1024 * 1024)
        bodies.append(b)
        return httpx.Response(
            200, headers={"content-type": "text/html; charset=utf-8"}, content=b)

    out = _fetch(wb, handler)
    assert out["http_status"] == 200
    assert out["title"] == "Probe Title"
    assert out["h1s"] == ["Main Heading"]
    assert out["lang_attr"] == "ru"
    assert out["truncated"] is True
    # The honest test: we pulled at most the cap plus one in-flight chunk,
    # NOT the 50 MB the server was offering.
    assert bodies[0].pulled <= CAP + 64 * 1024
    assert bodies[0].pulled < 50 * 1024 * 1024


def test_small_page_is_unchanged_and_not_flagged(wb):
    html = HEAD + b"</p><h2>Sub</h2></body></html>"

    def handler(_req):
        return httpx.Response(
            200, headers={"content-type": "text/html; charset=utf-8"},
            content=Body(html, total=len(html)))

    out = _fetch(wb, handler)
    expected = wb.parse_snapshot_html(html.decode("utf-8"))
    for key, val in expected.items():
        assert out[key] == val, key
    assert "truncated" not in out


def test_gzip_cap_applies_to_decoded_bytes(wb):
    """30 MB of page compresses to ~30 KB. The cap must bound the EXPANDED
    size, and we must stop pulling compressed bytes early too."""
    comp = gzip.compress(HEAD + b"x" * (30 * 1024 * 1024))
    body = Body(comp, total=len(comp), chunk=1024)

    def handler(_req):
        return httpx.Response(
            200,
            headers={"content-type": "text/html", "content-encoding": "gzip"},
            content=body)

    out = _fetch(wb, handler)
    assert out["title"] == "Probe Title"
    assert out["truncated"] is True
    assert body.pulled < len(comp)


# --- decoding parity -------------------------------------------------------


def test_cp1251_page_decodes_correctly_through_the_stream(wb):
    """The operator's .kz/.ru drops: a Cyrillic page with a charset header
    must come out readable, end to end, through the streamed path."""
    html = ("<html><head><title>Купить телефон</title></head>"
            "<body><h1>Главная</h1></body></html>").encode("cp1251")

    def handler(_req):
        return httpx.Response(
            200, headers={"content-type": "text/html; charset=windows-1251"},
            content=Body(html, total=len(html)))

    out = _fetch(wb, handler)
    assert out["title"] == "Купить телефон"
    assert out["h1s"] == ["Главная"]


@pytest.mark.parametrize("ctype,raw", [
    ("text/html; charset=windows-1251", "Привет мир".encode("cp1251")),
    ("text/html", "Привет мир".encode("utf-8")),
    ("text/html; charset=iso-8859-1", "café".encode("latin-1")),
    ("text/html", b"\xff\xfe broken \xc3"),
    ("text/html; charset=no-such-codec", "Привет".encode("utf-8")),
])
def test_decode_matches_what_httpx_text_produced(wb, ctype, raw):
    """Parity with the OLD behaviour: `_decode_body` must equal httpx's
    own `.text` for every charset situation, including a missing one,
    invalid bytes and a bogus codec name."""
    expected = httpx.Response(200, headers={"content-type": ctype},
                              content=raw).text
    probe = httpx.Response(200, headers={"content-type": ctype}, content=raw)
    assert wb._decode_body(probe, raw) == expected


def test_encoding_resolves_before_the_body_is_read(wb):
    """What makes streaming safe: httpx can name the encoding from the
    headers alone, without the body, because our clients use the default
    string `default_encoding`."""
    async def run(ctype):
        async def gen():
            yield b"never read"
        return httpx.Response(200, headers={"content-type": ctype},
                              content=gen()).encoding

    assert asyncio.run(run("text/html; charset=windows-1251")) == "windows-1251"
    assert asyncio.run(run("text/html")) == "utf-8"


# --- bodies are only read where they are used -----------------------------


def test_redirect_uses_location_and_reads_no_body(wb):
    bodies = []

    def handler(_req):
        b = Body(b"<html>moved</html>", total=10 * 1024 * 1024)
        bodies.append(b)
        return httpx.Response(
            301,
            headers={"location":
                     "https://web.archive.org/web/20200101000000/http://new.kz/"},
            content=b)

    out = _fetch(wb, handler)
    assert out["http_status"] == 301
    assert "new.kz" in out["redirect_to"]
    assert bodies[0].pulled == 0


def test_404_reads_no_body(wb):
    bodies = []

    def handler(_req):
        b = Body(b"not found", total=5 * 1024 * 1024)
        bodies.append(b)
        return httpx.Response(404, headers={"content-type": "text/html"},
                              content=b)

    out = _fetch(wb, handler)
    assert out["http_status"] == 404
    assert out["error"] == "http 404"
    assert bodies[0].pulled == 0


def test_maintenance_503_detected_with_a_small_probe_and_no_retry(wb):
    page = b"<html><body>Internet Archive is temporarily offline.</body></html>"
    bodies = []

    def handler(_req):
        b = Body(page, total=5 * 1024 * 1024, chunk=4 * 1024, filler=b" ")
        bodies.append(b)
        return httpx.Response(503, headers={"content-type": "text/html"},
                              content=b)

    out = _fetch(wb, handler)
    assert out["error"] == wb._IA_OFFLINE_MSG
    assert len(bodies) == 1                       # fast-fail, no retry
    assert bodies[0].pulled <= PROBE + 4 * 1024   # a probe, not 5 MB


# --- retry and failure behaviour is unchanged -----------------------------


def test_generic_503_is_retried_then_reported(wb):
    calls = []

    def handler(_req):
        calls.append(1)
        return httpx.Response(503, headers={"content-type": "text/html"},
                              content=b"busy backend")

    out = _fetch(wb, handler)
    assert out["http_status"] == 503
    assert out["error"] == "http 503 after retries"
    assert len(calls) == 3                        # retry_max=2 -> 3 attempts


def test_429_is_retried_then_reported(wb):
    calls = []

    def handler(_req):
        calls.append(1)
        return httpx.Response(429, content=b"slow down")

    out = _fetch(wb, handler)
    assert out["http_status"] == 429
    assert len(calls) == 3


def test_drop_mid_body_is_a_network_error_and_is_retried(wb):
    """A failure while READING the body must behave like a failed request:
    retried, then reported — not escape as an unhandled exception."""
    calls = []

    def handler(_req):
        calls.append(1)
        return httpx.Response(
            200, headers={"content-type": "text/html"},
            content=Body(HEAD, total=1024 * 1024, fail_after=128 * 1024))

    out = _fetch(wb, handler)
    assert out["http_status"] == 0
    assert out["error"].startswith("network")
    assert len(calls) == 3


def test_recovers_when_a_retry_succeeds(wb):
    calls = []
    html = HEAD + b"</p></body></html>"

    def handler(_req):
        calls.append(1)
        if len(calls) == 1:
            return httpx.Response(503, headers={"content-type": "text/html"},
                                  content=b"busy")
        return httpx.Response(200, headers={"content-type": "text/html"},
                              content=Body(html, total=len(html)))

    out = _fetch(wb, handler)
    assert out["http_status"] == 200
    assert out["title"] == "Probe Title"
    assert len(calls) == 2


# --- helpers ---------------------------------------------------------------


def test_read_capped_below_and_above_the_limit(wb):
    async def run(total, limit):
        r = httpx.Response(200, content=Body(b"", total=total, chunk=1000))
        return await wb._read_capped(r, limit)

    data, trunc = asyncio.run(run(500, 1000))
    assert len(data) == 500 and trunc is False
    data, trunc = asyncio.run(run(5000, 1000))
    assert len(data) == 1000 and trunc is True


def test_offline_check_still_works_for_the_cdx_caller(wb):
    """CDX passes no text and must keep reading resp.text, unchanged."""
    r = httpx.Response(503, headers={"content-type": "text/html"},
                       content=b"<p>We are temporarily offline</p>")
    assert wb._is_ia_offline(r) is True
    # Supplied text wins over the response body.
    assert wb._is_ia_offline(r, "nothing relevant") is False
    # Non-503 is never "offline", whatever the text says.
    ok = httpx.Response(200, headers={"content-type": "text/html"},
                        content=b"temporarily offline")
    assert wb._is_ia_offline(ok) is False


# --- body excerpt length ---------------------------------------------------


def test_body_excerpt_is_capped_at_300_characters(wb):
    """Raised 150 -> 300 so the excerpt gets past navigation boilerplate.
    Pinned here so a future change to the constant is a deliberate one."""
    assert wb._BODY_EXCERPT_CHARS == 300
    words = " ".join("word%d" % i for i in range(400))      # ~3,000 chars
    out = wb.parse_snapshot_html("<html><body><p>%s</p></body></html>" % words)
    excerpt = out["body_excerpt"]
    assert excerpt.endswith("…")                         # truncated marker
    assert len(excerpt) <= 300 + 1                            # cap + the ellipsis
    assert len(excerpt) > 150 + 1                             # actually longer now


def test_short_body_excerpt_is_returned_whole(wb):
    out = wb.parse_snapshot_html("<html><body><p>Short   page\n text.</p></body></html>")
    assert out["body_excerpt"] == "Short page text."         # collapsed, no ellipsis


# --- parsing must not freeze the event loop -------------------------------
#
# The API is ONE uvicorn worker: a single event loop serves page requests
# and runs jobs. Parsing an archived page inline froze that loop, so pages
# stalled until Cloudflare returned 524 — which looked like a reboot.


def _ok_handler(html):
    def handler(_req):
        return httpx.Response(200, headers={"content-type": "text/html"},
                              content=Body(html, total=len(html)))
    return handler


def test_parsing_runs_on_the_dedicated_pool_not_the_loop(wb, monkeypatch):
    seen = {}
    real = wb.parse_snapshot_html

    def spy(html):
        seen["thread"] = threading.current_thread().name
        return real(html)

    monkeypatch.setattr(wb, "parse_snapshot_html", spy)
    out = _fetch(wb, _ok_handler(HEAD + b"</p></body></html>"))
    assert out["title"] == "Probe Title"          # result still flows back
    assert seen["thread"].startswith("wb-parse"), seen
    assert seen["thread"] != threading.main_thread().name


def test_event_loop_keeps_serving_while_a_page_parses(wb, monkeypatch):
    """THE property. A heartbeat coroutine stands in for incoming page
    requests and must keep ticking while a deliberately slow, CPU-bound
    parse runs. Inline parsing would freeze it at zero ticks."""
    state = {"parsing": False, "ticks": 0}

    def slow_parse(_html):
        state["parsing"] = True
        end = time.perf_counter() + 0.4
        while time.perf_counter() < end:      # pure-Python CPU, holds the GIL
            pass
        state["parsing"] = False
        return {"title": "", "h1s": [], "h2s": [], "h3s": [],
                "body_excerpt": "", "lang_attr": ""}

    monkeypatch.setattr(wb, "parse_snapshot_html", slow_parse)
    html = HEAD + b"</p></body></html>"

    async def run():
        p = wb.WaybackClient()
        p._client = httpx.AsyncClient(transport=httpx.MockTransport(_ok_handler(html)))
        stop = asyncio.Event()

        async def heartbeat():
            while not stop.is_set():
                if state["parsing"]:
                    state["ticks"] += 1
                await asyncio.sleep(0.01)

        hb = asyncio.create_task(heartbeat())
        try:
            await p.fetch_snapshot_page(timestamp="20200101000000",
                                        url="http://example.kz/")
        finally:
            stop.set()
            await hb
            await p._client.aclose()

    asyncio.run(run())
    # ~25 ticks are expected in 0.4 s; 3 leaves wide margin for a slow box.
    assert state["ticks"] >= 3, state


def test_concurrent_fetches_all_complete_through_the_pool(wb):
    """More parses than pool threads must queue and finish, not deadlock."""
    html = HEAD + b"</p></body></html>"

    async def run():
        p = wb.WaybackClient()
        p._client = httpx.AsyncClient(transport=httpx.MockTransport(_ok_handler(html)))
        try:
            return await asyncio.gather(*[
                p.fetch_snapshot_page(timestamp="20200101000000",
                                      url="http://example.kz/%d" % i)
                for i in range(8)
            ])
        finally:
            await p._client.aclose()

    outs = asyncio.run(run())
    assert len(outs) == 8 and all(o["title"] == "Probe Title" for o in outs)
