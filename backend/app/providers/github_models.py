"""GitHub Models API client.

Test-connection lists available catalog models. The catalog endpoint accepts
a PAT with the `models:read` scope, doesn't bill, and is the cheapest health
check available.

Docs: https://docs.github.com/en/rest/models"""
from __future__ import annotations

from ..app_settings import get_provider_creds
from .base import BaseProvider, ProviderConfigError, ProviderError

CATALOG_URL = "https://models.github.ai/catalog/models"


class GitHubModelsClient(BaseProvider):
    name = "github_models"

    def _auth_headers(self) -> dict[str, str]:
        creds = get_provider_creds("github_models")
        token = creds.get("token", "")
        if not token:
            raise ProviderConfigError("GitHub Models token not set")
        return {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    async def test_credentials(self) -> dict:
        headers = self._auth_headers()
        try:
            r = await self.client.get(CATALOG_URL, headers=headers)
        except Exception as e:
            raise ProviderError(f"network error: {e}") from e
        if r.status_code in (401, 403):
            raise ProviderConfigError(
                f"GitHub Models rejected the token ({r.status_code}) — check it has the `models:read` scope"
            )
        if r.status_code >= 400:
            raise ProviderError(f"GitHub Models returned {r.status_code}: {r.text[:200]}")
        data = r.json() or []
        # Catalog returns a JSON array of model entries.
        models = data if isinstance(data, list) else data.get("models", []) or []
        creds = get_provider_creds("github_models")
        default_model = creds.get("default_model", "")
        ids = {m.get("id") or m.get("name") or "" for m in models}
        default_ok = (not default_model) or default_model in ids
        return {
            "ok": True,
            "provider": "github_models",
            "model_count": len(models),
            "default_model": default_model or None,
            "default_model_available": default_ok,
        }
