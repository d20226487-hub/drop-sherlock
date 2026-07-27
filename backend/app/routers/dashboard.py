"""Dashboard endpoints — runs `test_credentials()` for every provider in
parallel and returns the per-provider verdict.

The four AI/Ahrefs test endpoints are all *free*: Ahrefs subscription-
info, Gemini list-models, GitHub Models catalog, OpenRouter auth/key.
Calling them on every dashboard refresh doesn't burn billable credits.

WhoisFreaks (added Wave 2b, 2026-05-15) is DIFFERENT — there's no free
auth-only ping endpoint, every Historical WHOIS request costs the
operator real money. So this probe is **configuration-only**: we report
"ok" iff the API key is set, "unconfigured" otherwise, and skip the
live call entirely. The existing Settings → Whois History → Test button
exists for explicit on-demand liveness probing (1 request per click,
operator decides when to pay).
"""
from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone

from fastapi import APIRouter

from ..app_settings import PROVIDER_FIELDS, provider_status
from ..providers import ProviderConfigError, ProviderError, get_provider

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


async def _probe(provider: str) -> dict:
    """Run a provider's test_credentials and shape the result into a
    Dashboard-friendly dict. Never raises — always returns a dict so the
    caller can `gather` without a single failure killing the batch."""
    started = datetime.now(timezone.utc)
    try:
        async with get_provider(provider) as p:
            details = await p.test_credentials()
        elapsed_ms = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
        return {
            "provider": provider,
            "state": "ok",
            "elapsed_ms": elapsed_ms,
            "details": details,
        }
    except ProviderConfigError as e:
        # Distinguishes "no key" vs "key rejected" by message; both are
        # actionable for the user but the UX intent is the same: configure
        # this provider in Settings.
        return {
            "provider": provider,
            "state": "unconfigured",
            "error": str(e),
        }
    except ProviderError as e:
        return {
            "provider": provider,
            "state": "error",
            "error": str(e),
        }
    except Exception as e:  # noqa: BLE001 — defensive: never crash the batch
        return {
            "provider": provider,
            "state": "error",
            "error": f"unexpected: {e!r}",
        }


# --- Whois History pillar probe (Wave 2b, 2026-05-15) ---------------------
#
# Kept separate from `_probe` because:
#   • Credentials live in the Whois History settings tab, not the main
#     API tab, so PROVIDER_FIELDS doesn't enumerate WhoisFreaks.
#   • The "test" semantics differ — there's no zero-cost ping endpoint,
#     so we issue the same 1-record-history lookup the Settings → Test
#     button uses.
#
# Result shape mirrors `_probe` so the dashboard renderer doesn't need
# to branch.


def _probe_whoisfreaks() -> dict:
    """Configuration-only probe — does NOT call the WhoisFreaks API.

    Why sync (no `async`): we don't perform any IO. Returns "ok" iff
    a key is stored, "unconfigured" otherwise. The state pill is
    therefore "is the integration ready to use", not "is it currently
    live + responding". Live verification is one click away in
    Settings → Whois History → Test (which DOES cost 1 request).

    Kept in the dashboard router instead of inlining the conditional
    in `status_overview` so the future option to add a free-tier ping
    (if WhoisFreaks ever exposes one) lands in a focused diff."""
    from ..app_settings import get_whois_history_api_key

    api_key = get_whois_history_api_key()
    if not api_key:
        return {
            "provider": "whoisfreaks",
            "state": "unconfigured",
            "error": (
                "WhoisFreaks API key not set — add one in "
                "Settings → Whois History."
            ),
        }
    return {
        "provider": "whoisfreaks",
        "state": "ok",
        # `elapsed_ms` is left off (no IO happened — reporting a
        # number would be misleading). The frontend treats missing
        # elapsed_ms gracefully (omits the "· Xms" suffix).
        "details": {
            # Distinct from the other providers' `details` schemas —
            # frontend's `summary()` reads `live_check_url` and
            # renders a "Use Settings → Test to verify live" hint
            # instead of a one-liner about the live response.
            "live_check_required": True,
            "live_check_url": "/settings",
        },
    }


def _probe_config_only(provider: str) -> dict:
    """Configuration-only check for an AI/Ahrefs provider — does NOT
    call the upstream. Returns "ok" when at least one credential
    field is set, "unconfigured" when nothing is stored. Used by the
    Dashboard's default (passive) page load so a casual navigation
    doesn't fire 4–5 HTTP requests in the background.

    The live equivalent is `_probe()`; the operator triggers it from
    the Dashboard's "Run live checks" button when they actually need
    to verify upstream health."""
    cfg = provider_status(provider)
    fields = (cfg.get("fields") or {})
    has_any_credential = any(
        (f.get("configured") is True)
        for f in fields.values()
    )
    if not has_any_credential and provider != "wayback":
        # Wayback has no fields by design (it's a public endpoint).
        # Treat that as configured-by-default so it doesn't show
        # "unconfigured" on a fresh deploy.
        return {
            "provider": provider,
            "state": "unconfigured",
            "error": "No credentials stored. Add one in Settings → API.",
            "configured": cfg,
        }
    return {
        "provider": provider,
        "state": "ok",
        # No elapsed_ms — IntegrationCard omits the time suffix when
        # the field is absent.
        "configured": cfg,
        # Hint flag so the IntegrationCard `summary` branch can render
        # "configured (use Live checks to verify)" instead of the
        # provider-specific live-response one-liner.
        "details": {"live_check_required": True},
    }


@router.get("/status")
async def status_overview(live: bool = False):
    """Per-provider Dashboard status.

    `live` (added Wave 2b, 2026-05-15):
      • false (default) — config-only for ALL providers. Zero
        upstream calls. Fast, free, no rate-limit pressure on the
        upstream test endpoints.
      • true            — fire the existing `_probe()` for AI/Ahrefs/
        Wayback (which use FREE upstream test endpoints), still
        config-only for WhoisFreaks (every WhoisFreaks request
        costs money — see `_probe_whoisfreaks` docstring).

    The two modes return the SAME dict shape so the frontend can swap
    between them with one fetch call and merge results into the same
    card layout. The `live` query param defaults to false so any
    pre-Wave-2b caller (page reload, bookmarked URL, scripted scrape)
    gets the cheap path automatically.
    """
    providers = list(PROVIDER_FIELDS.keys())
    if live:
        live_results = await asyncio.gather(*(_probe(p) for p in providers))
        results = list(live_results) + [_probe_whoisfreaks()]
    else:
        results = [_probe_config_only(p) for p in providers]
        results.append(_probe_whoisfreaks())
    # `configured` shape is attached inside _probe_config_only for the
    # passive path. For the live path it's only attached when the
    # provider participates in PROVIDER_FIELDS (whoisfreaks already
    # encodes its config-state via the `state` field directly).
    if live:
        for r in results:
            if r["provider"] in PROVIDER_FIELDS:
                r["configured"] = provider_status(r["provider"])
    return {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "mode": "live" if live else "config",
        "integrations": results,
    }


# --- Ahrefs unit balance (2026-07-27) -------------------------------------
# Surfaced on the Dashboard so the operator sees remaining API units + the
# monthly reset date at a glance (and a red highlight when the balance runs
# low). Uses the FREE subscription-info/limits-and-usage endpoint (no row
# credit — same call as the Ahrefs status probe), cached for a short TTL so
# frequent dashboard loads / multiple LAN users don't spam Ahrefs.

_units_cache: dict = {"data": None, "at": 0.0}
# 60 min — the balance moves slowly, so a passive dashboard load doesn't need
# a fresh probe often. The Dashboard's manual Refresh button (force=true)
# covers "check it right now".
_UNITS_TTL_SEC = 3600.0


async def _fetch_ahrefs_units() -> dict:
    try:
        async with get_provider("ahrefs") as p:
            details = await p.test_credentials()
    except ProviderConfigError as e:
        return {"state": "unconfigured", "error": str(e)}
    except ProviderError as e:
        return {"state": "error", "error": str(e)}
    except Exception as e:  # noqa: BLE001 — never 500 the dashboard
        return {"state": "error", "error": f"unexpected: {e!r}"}
    raw = (details or {}).get("raw") or {}
    limit = raw.get("units_limit_workspace")
    used = raw.get("units_usage_workspace")
    limit_n = limit if isinstance(limit, (int, float)) else None
    used_n = used if isinstance(used, (int, float)) else None
    remaining = (
        int(limit_n) - int(used_n)
        if limit_n is not None and used_n is not None
        else None
    )
    return {
        "state": "ok",
        "subscription": raw.get("subscription"),
        "units_limit": limit_n,
        "units_used": used_n,
        "units_remaining": remaining,
        "usage_reset_date": raw.get("usage_reset_date"),
        "api_key_expiration_date": raw.get("api_key_expiration_date"),
    }


@router.get("/ahrefs-units")
async def ahrefs_units(force: bool = False):
    """Ahrefs API unit balance for the Dashboard (FREE upstream call, cached
    ~60 min). Pass `?force=true` (the Dashboard's manual Refresh button) to
    bypass the cache and re-probe now. Returns {state, units_limit,
    units_used, units_remaining, usage_reset_date, subscription,
    api_key_expiration_date}; `state` is 'ok' | 'unconfigured' | 'error' so
    the frontend can degrade gracefully. The <1,000,000 red-highlight rule
    is a frontend display concern."""
    now = time.monotonic()
    cached = _units_cache["data"]
    if not force and cached is not None and now - _units_cache["at"] < _UNITS_TTL_SEC:
        return cached
    result = await _fetch_ahrefs_units()
    # Only cache good reads — a transient error / just-fixed key should
    # re-probe on the next load rather than stick around for the full TTL.
    if result.get("state") == "ok":
        _units_cache["data"] = result
        _units_cache["at"] = now
    return result
