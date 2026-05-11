"""Google Gemini API client.

Test-connection lists models — free, fast, doesn't burn quota.
Docs: https://ai.google.dev/api/rest/v1beta/models/list"""
from __future__ import annotations

from ..app_settings import get_provider_creds
from .base import BaseProvider, ProviderConfigError, ProviderError

API_BASE = "https://generativelanguage.googleapis.com/v1beta"


class GeminiClient(BaseProvider):
    name = "gemini"

    def _api_key(self) -> str:
        creds = get_provider_creds("gemini")
        api_key = creds.get("api_key", "")
        if not api_key:
            raise ProviderConfigError("Gemini API key not set")
        return api_key

    async def test_credentials(self) -> dict:
        api_key = self._api_key()
        url = f"{API_BASE}/models"
        try:
            r = await self.client.get(url, params={"key": api_key})
        except Exception as e:
            raise ProviderError(f"network error: {e}") from e
        if r.status_code in (401, 403):
            raise ProviderConfigError(f"Gemini rejected the API key ({r.status_code})")
        if r.status_code >= 400:
            raise ProviderError(f"Gemini returned {r.status_code}: {r.text[:200]}")
        data = r.json() or {}
        models = data.get("models") or []
        creds = get_provider_creds("gemini")
        default_model = creds.get("default_model", "")
        # Confirm the chosen default model is actually accessible to this key.
        model_names = {(m.get("name") or "").rsplit("/", 1)[-1] for m in models}
        default_ok = (not default_model) or default_model in model_names
        return {
            "ok": True,
            "provider": "gemini",
            "model_count": len(models),
            "default_model": default_model or None,
            "default_model_available": default_ok,
        }
