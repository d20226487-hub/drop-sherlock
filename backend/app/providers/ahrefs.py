"""Ahrefs API client.

Test-connection uses `subscription-info` — it doesn't consume a row credit
and returns a useful summary (plan + remaining rows) for the status pill.
Docs: https://docs.ahrefs.com/api/reference/subscription-info

`fetch_url()` is the worker-side method used by the job runner. It accepts
a fully-built URL (from `ahrefs_requests.build_preview()`), retries 429/5xx
with exponential backoff up to the configured `retry_max`, and returns the
parsed JSON body.

Rate limiting is NOT applied inside this method — the caller is expected to
acquire a token from `app.limits.limit("ahrefs")` first. This keeps the
fetch composable with any future test/replay scenarios that bypass the
limiter."""
from __future__ import annotations

import asyncio
import random

from ..app_settings import get_provider_creds, get_rate_limits
from .base import BaseProvider, ProviderConfigError, ProviderError

API_BASE = "https://api.ahrefs.com/v3"


# Sleep multipliers for retry: 1s, 2s, 4s, ... capped at 30s. Jitter ±25%
# spreads simultaneous retries.
def _backoff(attempt: int) -> float:
    base = min(30.0, 2 ** attempt)
    jitter = random.uniform(0.75, 1.25)
    return base * jitter


class AhrefsClient(BaseProvider):
    name = "ahrefs"

    def _auth_headers(self) -> dict[str, str]:
        creds = get_provider_creds("ahrefs")
        api_key = creds.get("api_key", "")
        if not api_key:
            raise ProviderConfigError("Ahrefs API key not set")
        return {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

    async def test_credentials(self) -> dict:
        headers = self._auth_headers()
        url = f"{API_BASE}/subscription-info/limits-and-usage"
        try:
            r = await self.client.get(url, headers=headers)
        except Exception as e:
            raise ProviderError(f"network error: {e}") from e
        if r.status_code == 401 or r.status_code == 403:
            raise ProviderConfigError(f"Ahrefs rejected the API key ({r.status_code})")
        if r.status_code >= 400:
            raise ProviderError(f"Ahrefs returned {r.status_code}: {r.text[:200]}")
        data = r.json() or {}
        # The exact shape depends on plan; surface a few useful fields if
        # they're there but never assume.
        info = data.get("limits_and_usage") or data
        return {
            "ok": True,
            "provider": "ahrefs",
            "raw": info,
        }

    async def fetch_url(self, url: str) -> tuple[int, dict, dict]:
        """Issue a GET against an already-built Ahrefs URL with exponential
        backoff on 429/5xx. Returns (http_status, json_body, units) where
        `units` carries the unit-cost data Ahrefs reports via response
        headers — see `_extract_units`. Raises ProviderConfigError on 401/403
        (key issue) or ProviderError if the retry budget is exhausted."""
        headers = self._auth_headers()
        retry_max = get_rate_limits("ahrefs").get("retry_max", 3)
        last_exc: Exception | None = None
        for attempt in range(retry_max + 1):
            try:
                r = await self.client.get(url, headers=headers)
            except Exception as e:
                last_exc = e
                if attempt < retry_max:
                    await asyncio.sleep(_backoff(attempt))
                    continue
                raise ProviderError(f"network error after {retry_max + 1} attempts: {e}") from e

            # Auth issues — never worth retrying.
            if r.status_code in (401, 403):
                raise ProviderConfigError(
                    f"Ahrefs rejected the API key ({r.status_code})"
                )

            # Throttled or transient upstream error — back off and retry.
            if r.status_code == 429 or 500 <= r.status_code < 600:
                if attempt < retry_max:
                    await asyncio.sleep(_backoff(attempt))
                    continue
                raise ProviderError(
                    f"Ahrefs returned {r.status_code} after {retry_max + 1} attempts: {r.text[:200]}"
                )

            # Anything else 4xx is a permanent client error — surface it.
            if r.status_code >= 400:
                raise ProviderError(
                    f"Ahrefs returned {r.status_code}: {r.text[:200]}"
                )

            return r.status_code, r.json() or {}, _extract_units(r.headers)

        # Defensive — loop should exit via return or raise.
        raise ProviderError(f"unreachable: retry exhausted ({last_exc!r})")


def _extract_units(headers) -> dict:
    """Pull unit-cost values from Ahrefs response headers.

    Ahrefs API v3 reports three relevant numbers on every Site Explorer
    response:
    - x-api-units-cost-row    : per-row cost (a multiplier, depends on endpoint)
    - x-api-units-cost-total  : list-price total for this request
    - x-api-units-cost-total-actual : units actually billed (Ahrefs caches
      identical recent requests on their side, so `actual` can be 0 when
      `total` is non-zero — surface the gap so users see when Ahrefs's own
      cache saved them).
    """
    def _maybe_int(v: str | None) -> int | None:
        if v is None:
            return None
        try:
            return int(v)
        except ValueError:
            return None
    return {
        "cost_row": _maybe_int(headers.get("x-api-units-cost-row")),
        "cost_total": _maybe_int(headers.get("x-api-units-cost-total")),
        "cost_actual": _maybe_int(
            headers.get("x-api-units-cost-total-actual")
        ),
    }
