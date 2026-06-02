"""Ahrefs /batch-analysis helper — shared by the ad-hoc Tools probe
(`routers/tools.py`) and the Ahrefs Batch Analysis Job runner
(`ahrefs_batch_analysis_runner.py`).

`/batch-analysis/batch-analysis` is a POST endpoint that returns current-
snapshot metrics for up to 100 targets per call (the API's hard ceiling).
A single call costs ~1 unit/target/field at scale. Responses are mapped
to inputs by ARRAY POSITION — Ahrefs preserves `targets` order in the
response (verified 2026-05-17 with forward/reverse order tests). There's
no `url` field in the select, so when Ahrefs drops a target (it rejects
the WHOLE batch when any target is syntactically invalid) the row count
mismatches and we can't position-map — the chunk is marked failed with a
hint to split-isolate.

Rate limiting is NOT applied here — the caller wraps the call in
`async with app.limits.limit("ahrefs")` (matches `providers/ahrefs.py`'s
contract for `fetch_url`).
"""
from __future__ import annotations

from dataclasses import dataclass, field

import httpx

# Allowlisted /batch-analysis metrics, in canonical display order. Maps
# the Ahrefs `select` field id → a short human label. Field ids verified
# against the batch-analysis OpenAPI outputSchema (2026-06-02).
# `domain_rating` is a float; everything else is an integer count.
BATCH_METRICS: dict[str, str] = {
    "domain_rating": "DR",
    "refdomains_dofollow": "Ref domains (follow)",
    "refdomains_nofollow": "Ref domains (nofollow)",
    "backlinks_dofollow": "Backlinks (follow)",
    "refips_subnets": "Ref IP subnets",
    "org_traffic": "Organic traffic",
    "org_keywords": "Organic keywords",
    "org_keywords_4_10": "Organic keywords 4-10",
    "org_keywords_11_20": "Organic keywords 11-20",
}

# Ahrefs caps `targets` at 100 per call (OpenAPI maxItems).
BATCH_SIZE = 100

_ENDPOINT = "https://api.ahrefs.com/v3/batch-analysis/batch-analysis"


def canonical_metrics(requested: list[str]) -> list[str]:
    """Filter `requested` to the allowlist, in BATCH_METRICS order.
    Drops unknown ids silently — callers that need to reject unknowns
    should check membership before calling."""
    wanted = set(requested)
    return [m for m in BATCH_METRICS if m in wanted]


@dataclass
class ChunkOutcome:
    """Result of one ≤100-target /batch-analysis call.

    On success (`error == ""`), `metrics_by_domain` has one entry per
    input domain (position-mapped) → {field_id: value|None}. On failure,
    `error` is set and `metrics_by_domain` is empty; the caller marks
    every domain in the chunk as errored with `error`.
    """
    http_status: int = 0
    metrics_by_domain: dict[str, dict[str, float | None]] = field(default_factory=dict)
    error: str = ""
    cost_list: int = 0
    cost_billed: int = 0


async def fetch_batch_chunk(
    client: httpx.AsyncClient,
    api_key: str,
    domains: list[str],
    select: list[str],
    *,
    country: str | None = None,
    timeout: float = 60.0,
) -> ChunkOutcome:
    """POST one chunk (≤100 domains) to /batch-analysis. Pure I/O — no
    DB, no rate-limit token (caller acquires that). Never raises:
    transport/HTTP/shape errors all come back on `ChunkOutcome.error`."""
    payload: dict = {
        "targets": [
            {"url": d, "mode": "subdomains", "protocol": "both"}
            for d in domains
        ],
        "select": list(select),
    }
    if country:
        # Scopes org_traffic / org_keywords to one country (ISO alpha-2).
        payload["country"] = country

    try:
        r = await client.post(
            _ENDPOINT,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=timeout,
        )
    except Exception as e:  # noqa: BLE001
        return ChunkOutcome(error=f"{type(e).__name__}: {e}")

    out = ChunkOutcome(http_status=r.status_code)
    # Cost headers are absent when Ahrefs rejects the whole batch.
    ct = r.headers.get("x-api-units-cost-total")
    ca = r.headers.get("x-api-units-cost-total-actual")
    if ct is not None:
        try:
            out.cost_list = int(ct)
        except ValueError:
            pass
    if ca is not None:
        try:
            out.cost_billed = int(ca)
        except ValueError:
            pass

    try:
        body = r.json()
    except Exception:  # noqa: BLE001
        body = None

    if r.status_code != 200 or not isinstance(body, dict):
        out.error = f"HTTP {r.status_code}"
        return out

    rows = body.get("targets")
    if not isinstance(rows, list):
        out.error = "unexpected response shape (no `targets` array)"
        return out

    # Length mismatch ⇒ Ahrefs dropped a target (usually a syntactically
    # invalid domain). We can't position-map; fail the whole chunk with a
    # hint so the operator can split-isolate the bad one.
    if len(rows) != len(domains):
        out.error = (
            f"batch dropped — sent {len(domains)} targets, got {len(rows)} "
            f"rows. Ahrefs rejects whole batches when any target is invalid; "
            f"split this chunk to isolate the bad one."
        )
        return out

    for domain, row in zip(domains, rows):
        metrics: dict[str, float | None] = {}
        if isinstance(row, dict):
            for fld in select:
                v = row.get(fld)
                metrics[fld] = float(v) if isinstance(v, (int, float)) else None
        out.metrics_by_domain[domain] = metrics
    return out
