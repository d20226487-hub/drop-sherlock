"""OpenRouter API client.

Test-connection hits `/api/v1/auth/key` — returns the key's label, usage,
and rate-limit status. Doesn't cost anything.
Docs: https://openrouter.ai/docs/api-reference/limits"""
from __future__ import annotations

from ..app_settings import get_provider_creds
from .base import BaseProvider, ProviderConfigError, ProviderError

API_BASE = "https://openrouter.ai/api/v1"


class OpenRouterClient(BaseProvider):
    name = "openrouter"

    def _auth_headers(self) -> dict[str, str]:
        creds = get_provider_creds("openrouter")
        api_key = creds.get("api_key", "")
        if not api_key:
            raise ProviderConfigError("OpenRouter API key not set")
        return {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

    async def test_credentials(self) -> dict:
        headers = self._auth_headers()
        try:
            r = await self.client.get(f"{API_BASE}/auth/key", headers=headers)
        except Exception as e:
            raise ProviderError(f"network error: {e}") from e
        if r.status_code in (401, 403):
            raise ProviderConfigError(f"OpenRouter rejected the API key ({r.status_code})")
        if r.status_code >= 400:
            raise ProviderError(f"OpenRouter returned {r.status_code}: {r.text[:200]}")
        data = (r.json() or {}).get("data") or {}
        creds = get_provider_creds("openrouter")
        default_model = creds.get("default_model", "")
        return {
            "ok": True,
            "provider": "openrouter",
            "label": data.get("label"),
            "usage": data.get("usage"),
            "limit": data.get("limit"),
            "default_model": default_model or None,
        }
