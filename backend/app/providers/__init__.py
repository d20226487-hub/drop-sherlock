"""Provider clients. Each class is an async context manager with at minimum
a `test_credentials()` method. Job-execution methods land in step 5/7."""
from __future__ import annotations

from .base import ProviderConfigError, ProviderError
from .ahrefs import AhrefsClient
from .gemini import GeminiClient
from .github_models import GitHubModelsClient
from .openrouter import OpenRouterClient
from .vertex_ai import VertexAIClient
from .wayback import WaybackClient

_REGISTRY = {
    "ahrefs": AhrefsClient,
    "gemini": GeminiClient,
    "github_models": GitHubModelsClient,
    "openrouter": OpenRouterClient,
    "vertex_ai": VertexAIClient,
    "wayback": WaybackClient,
}


def get_provider(name: str):
    """Return an *unentered* async context manager — caller does
    `async with get_provider("ahrefs") as p:`."""
    cls = _REGISTRY.get(name)
    if cls is None:
        raise ProviderConfigError(f"unknown provider: {name}")
    return cls()


__all__ = [
    "ProviderConfigError",
    "ProviderError",
    "AhrefsClient",
    "GeminiClient",
    "GitHubModelsClient",
    "OpenRouterClient",
    "VertexAIClient",
    "WaybackClient",
    "get_provider",
]
