"""Public view-only share endpoints (added 2026-05-15).

Routes here are mounted under `/public/*` and are reachable **without
basic-auth** — Caddy explicitly bypasses its auth for `/api/public/*`.
Every endpoint MUST validate a share token before returning anything;
there are no authenticated callers here.

Two threat models matter for the design:

1. **Enumeration / brute-force token guessing.** Tokens are 32 chars
   urlsafe (~190 bits of entropy) so brute force is statistically out of
   reach. We still rate-limit by client IP to make scraping detectable
   and to avoid noisy logs / DB churn.
2. **Information leakage past revocation.** The token check happens on
   every request — there's no in-memory caching of "this token is valid"
   that could survive a revoke. The DB lookup is index-served (PK on
   token) so the per-request cost is negligible.

The endpoint reuses the existing `get_run_domain_detail` route function
directly (calling it as a regular Python function with an explicit
Session) and post-processes its dict to strip operator-only fields
(cost, request URLs, internal IDs, ai_provider/ai_model). The recipient
sees analysis content; they don't see the API integrations behind it.
"""
from __future__ import annotations

import asyncio
import time
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Depends
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import DomainShare, RunDomain
from .jobs import get_run_domain_detail

router = APIRouter(prefix="/public", tags=["public-shares"])


# --- In-memory per-IP rate limit -------------------------------------------
# Single-uvicorn-worker deploy means a process-local dict is sufficient.
# 60 requests / 60s per source IP is generous for legitimate single-page
# loads (each domain page load fires one /public/share/<token> call) but
# would catch a scraper hammering hundreds of tokens.
#
# Implementation note: we don't reuse the `limits.py` provider limiter
# because that's for OUTBOUND fan-out to upstream APIs. The two regimes
# have different requirements:
#   - Outbound: smooth token refill so callers don't burst above RPM
#   - Inbound: hard cap per source IP, blocking caller-side, never
#     queues — over-limit just returns 429
# Sharing infrastructure would force one to look like the other.

_RATE_WINDOW_SECONDS = 60.0
_RATE_MAX_PER_WINDOW = 60
_rate_state: dict[str, list[float]] = {}
_rate_lock = asyncio.Lock()


async def _rate_limit_check(ip: str) -> None:
    """Raise 429 if `ip` has made more than _RATE_MAX_PER_WINDOW requests
    in the last _RATE_WINDOW_SECONDS. Sliding-window — older timestamps
    are pruned on each call so memory stays bounded.

    The lock guards both the read and the prune+append; the critical
    section is microseconds long (list slice + append) so contention
    isn't a real concern at the scales this app sees.
    """
    now = time.monotonic()
    cutoff = now - _RATE_WINDOW_SECONDS
    async with _rate_lock:
        hits = _rate_state.get(ip)
        if hits is None:
            _rate_state[ip] = [now]
            return
        # Drop expired timestamps (everything older than cutoff).
        kept = [t for t in hits if t >= cutoff]
        if len(kept) >= _RATE_MAX_PER_WINDOW:
            _rate_state[ip] = kept
            raise HTTPException(
                429,
                f"Too many requests — limit is "
                f"{_RATE_MAX_PER_WINDOW}/min per IP. Try again in "
                f"{int(_RATE_WINDOW_SECONDS)}s.",
            )
        kept.append(now)
        _rate_state[ip] = kept


def _client_ip(request: Request) -> str:
    """First X-Forwarded-For hop if Caddy added it; else the direct peer.
    Caddy is configured to forward, so the real client IP appears here
    even though the FastAPI socket is on the Docker network."""
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",", 1)[0].strip()
    if request.client is not None:
        return request.client.host
    return ""


# --- Token resolution ------------------------------------------------------

def _resolve_active_share(token: str, db: Session) -> DomainShare:
    """Load + validate a share token. Raises 404 for any failure mode
    (missing / revoked / expired) — we deliberately do NOT distinguish
    between them in the response so a probe can't tell whether a token
    ever existed."""
    if not token or len(token) > 64:
        raise HTTPException(404, "share not found")
    share = db.get(DomainShare, token)
    if share is None:
        raise HTTPException(404, "share not found")
    if share.revoked_at is not None:
        raise HTTPException(404, "share not found")
    if share.expires_at is not None and share.expires_at <= datetime.utcnow():
        raise HTTPException(404, "share not found")
    return share


def _sanitize_public_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Strip operator-only fields from a `get_run_domain_detail` dict
    before returning it to a public viewer.

    The recipient sees:
      * domain, status, dates, criteria verdicts + sample data,
        Wayback timeline, final assessment, notes (read-only)
    The recipient does NOT see:
      * cost / token / pricing-coverage info (your spend)
      * Ahrefs request URLs (would expose query shape + API key path)
      * ai_provider / ai_model (reveals which AI vendor you're using)
      * units_cost_* (Ahrefs unit accounting)
      * cached_from / ai_cached_from / source_run / source_job IDs
        (internal plumbing)
      * pinning / reanalyzing flags (operator-only state)
      * augmentation chain IDs (would let recipient follow back into the
        operator's internal job/run graph if those routes were ever
        exposed publicly).
    """
    out = dict(payload)
    # Top-level operator-only fields.
    for k in (
        "cost",
        "is_pinned",
        "reanalyzing",
        "final_source_run_id",
        "final_source_run_domain_id",
        "final_source_job_id",
        "augments_run_id",
        "augments_run_domain_id",
        "augments_job_id",
        "spec_ai_provider",
        "spec_ai_model",
    ):
        out.pop(k, None)

    # Per-criterion: strip operator-only keys but keep the analysis body.
    criteria = out.get("criteria")
    if isinstance(criteria, dict):
        clean_criteria: dict[str, dict] = {}
        for name, body in criteria.items():
            if not isinstance(body, dict):
                clean_criteria[name] = body
                continue
            clean_body = {
                k: v for k, v in body.items()
                if k not in {
                    "request_url",
                    "ai_provider",
                    "ai_model",
                    "units_cost_row",
                    "units_cost_total",
                    "units_cost_actual",
                    "cached_from_run_id",
                    "ai_cached_from_run_id",
                    "source_run_id",
                    "source_run_domain_id",
                    "source_job_id",
                }
            }
            clean_criteria[name] = clean_body
        out["criteria"] = clean_criteria

    # Final assessment: strip the provider/model fields the AI judge
    # emits, but keep the prose (assessment, summary, recommendation,
    # confidence, final score). These are the actual recommendation
    # content — the whole point of the share.
    fa = out.get("final_assessment")
    if isinstance(fa, dict):
        out["final_assessment"] = {
            k: v for k, v in fa.items() if k not in {"provider", "model"}
        }
    return out


# --- Routes ----------------------------------------------------------------

@router.get("/share/{token}")
async def get_public_share(
    token: str,
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    """View-only run-domain detail. Returns the same body shape as
    `GET /run-domains/{id}` minus operator-only fields.

    Rate-limited at 60 req/min per source IP. Increments view_count +
    last_viewed_at on every successful hit so the management UI can
    surface activity.
    """
    await _rate_limit_check(_client_ip(request))
    share = _resolve_active_share(token, db)

    rd = db.get(RunDomain, share.run_domain_id)
    if rd is None:
        # Target RunDomain was deleted out from under the share. We
        # could revoke the share automatically here, but the operator
        # may prefer to inspect it in the management UI first — so we
        # just 404 the recipient and leave the share row visible.
        raise HTTPException(404, "share not found")

    # Reuse the existing per-domain detail builder. Calling the route
    # function directly with an explicit Session bypasses the
    # `Depends(get_db)` default — that default is only consulted when
    # FastAPI invokes the handler via routing.
    payload = get_run_domain_detail(rd.id, db=db)
    safe = _sanitize_public_payload(payload)

    # Decorate with share metadata so the public page can show
    # "shared {when}" / expiry / a viewer-facing note (if the operator
    # wrote one). View_count is NOT exposed publicly — it would be a
    # signal for scrapers to estimate ROI.
    safe["share"] = {
        "token": share.token,
        "shared_at": share.created_at.isoformat(),
        "expires_at": (
            share.expires_at.isoformat() if share.expires_at else None
        ),
        "note": share.note,
    }

    # Side-effect: bump the view counter. Do this LAST so a sanitize/
    # build error doesn't inflate the count for a request that failed
    # to render. Single-statement update; no commit ordering hazards.
    share.view_count = (share.view_count or 0) + 1
    share.last_viewed_at = datetime.utcnow()
    db.commit()

    return safe
