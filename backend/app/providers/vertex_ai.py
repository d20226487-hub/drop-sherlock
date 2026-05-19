"""Vertex AI provider client.

Test-connection has two modes:

  • Service-account JSON (enterprise): mint an OAuth2 access token and
    hit the regional aiplatform models list endpoint for the configured
    project. Free, no token cost. Confirms project + location + SA are
    all consistent.
  • Vertex Express (API key): hit the global aiplatform endpoint via
    `?key=` and list `publishers/google/models`. Also free.

Auto-picks based on which creds are filled in.

Test failures are surfaced as ProviderConfigError (4xx auth) or
ProviderError (5xx / network) so the Dashboard pill stays consistent
with the other providers.
"""
from __future__ import annotations

from ..app_settings import get_provider_creds
from .base import BaseProvider, ProviderConfigError, ProviderError


class VertexAIClient(BaseProvider):
    name = "vertex_ai"

    async def test_credentials(self) -> dict:
        creds = get_provider_creds("vertex_ai")
        sa_json = (creds.get("service_account_json") or "").strip()
        api_key = (creds.get("api_key") or "").strip()
        default_model = (creds.get("default_model") or "").strip()
        if sa_json:
            return await self._test_service_account(
                sa_json,
                project_id=(creds.get("project_id") or "").strip(),
                location=(creds.get("location") or "").strip(),
                default_model=default_model,
            )
        if api_key:
            return await self._test_api_key(
                api_key, default_model=default_model,
            )
        raise ProviderConfigError(
            "Vertex AI: neither service_account_json nor api_key is set"
        )

    async def _test_service_account(
        self,
        sa_json: str,
        *,
        project_id: str,
        location: str,
        default_model: str,
    ) -> dict:
        if not project_id:
            raise ProviderConfigError(
                "Vertex AI: project_id required for service-account mode"
            )
        if not location:
            raise ProviderConfigError(
                "Vertex AI: location required for service-account mode"
            )
        from ..ai_judge import _mint_vertex_access_token
        # Surfaces ProviderConfigError on JSON/OAuth2 problems with a
        # readable message — let it bubble up unchanged.
        token = _mint_vertex_access_token(sa_json)
        # Hitting `models:list` would 403 unless we also configure a
        # tenant — instead we use `publishers/google/models` list which
        # works on any project with Vertex AI enabled. Free; no quota
        # cost.
        url = (
            f"https://{location}-aiplatform.googleapis.com/v1/"
            f"projects/{project_id}/locations/{location}/"
            "publishers/google/models"
        )
        try:
            r = await self.client.get(
                url,
                headers={"Authorization": f"Bearer {token}"},
            )
        except Exception as e:
            raise ProviderError(f"network error: {e}") from e
        if r.status_code in (401, 403):
            raise ProviderConfigError(
                f"Vertex AI rejected credentials ({r.status_code}): {r.text[:200]}"
            )
        if r.status_code >= 400:
            raise ProviderError(
                f"Vertex AI returned {r.status_code}: {r.text[:200]}"
            )
        data = r.json() or {}
        models = data.get("publisherModels") or data.get("models") or []
        return {
            "ok": True,
            "provider": "vertex_ai",
            "mode": "service_account",
            "project_id": project_id,
            "location": location,
            "model_count": len(models),
            "default_model": default_model or None,
        }

    async def _test_api_key(
        self, api_key: str, *, default_model: str,
    ) -> dict:
        url = (
            "https://aiplatform.googleapis.com/v1/"
            "publishers/google/models"
        )
        try:
            r = await self.client.get(url, params={"key": api_key})
        except Exception as e:
            raise ProviderError(f"network error: {e}") from e
        if r.status_code in (401, 403):
            raise ProviderConfigError(
                f"Vertex AI rejected the API key ({r.status_code})"
            )
        if r.status_code >= 400:
            raise ProviderError(
                f"Vertex AI returned {r.status_code}: {r.text[:200]}"
            )
        data = r.json() or {}
        models = data.get("publisherModels") or data.get("models") or []
        return {
            "ok": True,
            "provider": "vertex_ai",
            "mode": "express",
            "model_count": len(models),
            "default_model": default_model or None,
        }
