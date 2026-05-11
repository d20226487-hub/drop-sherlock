"""Dashboard endpoints — runs `test_credentials()` for every provider in
parallel and returns the per-provider verdict.

The four chosen test endpoints are all *free* (Ahrefs subscription-info,
Gemini list-models, GitHub Models catalog, OpenRouter auth/key), so calling
them on every dashboard visit doesn't burn billable credits."""
from __future__ import annotations

import asyncio
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


@router.get("/status")
async def status_overview():
    providers = list(PROVIDER_FIELDS.keys())
    results = await asyncio.gather(*(_probe(p) for p in providers))
    # Attach the masked configured-state too so the UI can distinguish
    # "no creds at all" from "creds set but failing live".
    for r in results:
        r["configured"] = provider_status(r["provider"])
    return {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "integrations": results,
    }
