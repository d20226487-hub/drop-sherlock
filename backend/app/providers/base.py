"""Common provider exceptions and a small async-context-manager base.

We don't push the abstraction further (no shared retry/rate-limit logic in
the base class) because step 2 only needs `test_credentials`. The token-bucket
limiter and retry policy land in step 5 and will be applied uniformly across
providers from there."""
from __future__ import annotations

import httpx


class ProviderError(Exception):
    """Upstream API said no — credentials were fine but something else broke."""


class ProviderConfigError(Exception):
    """Local config is missing or wrong — credentials not set, etc."""


class BaseProvider:
    timeout = httpx.Timeout(20.0, connect=10.0)

    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None

    async def __aenter__(self):
        self._client = httpx.AsyncClient(timeout=self.timeout)
        return self

    async def __aexit__(self, exc_type, exc, tb):
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            raise RuntimeError("provider used outside `async with` block")
        return self._client
