from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # API keys can also be set/overridden in the Settings UI; the DB value
    # takes precedence over the env value at runtime.
    ahrefs_api_key: str = ""
    gemini_api_key: str = ""
    github_models_token: str = ""
    openrouter_api_key: str = ""

    database_url: str = "sqlite:////data/drop_sherlock.db"

    # Rate-limit defaults — overridable per-API in the Settings UI.
    ahrefs_rpm: int = 60
    ahrefs_max_concurrent_domains: int = 4
    ahrefs_retry_max: int = 3

    # Comma-separated list of origins allowed to call the API. The Caddy
    # same-origin reverse proxy means most deploys only need their own
    # hostname here. Set to "*" only for development. Defaults cover the
    # local Docker stack + the dev preview port.
    cors_allow_origins: str = "http://localhost:8081,https://localhost:8444"

    # Comma-separated Fernet keys for at-rest encryption of provider
    # secrets (api_keys, tokens, S3 access keys) in the app_settings
    # table. First key in the list is "primary" (used to encrypt new
    # writes); remaining keys decrypt legacy values for graceful
    # rotation. Empty = fall back to the key file at /data/.fernet_key
    # (auto-generated on first boot if missing — see crypto.py).
    fernet_keys: str = ""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
