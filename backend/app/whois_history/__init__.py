"""Historical WHOIS pillar (Wave 2, 2026-05-15) — drop-detection from
WHOIS history snapshots.

Used as a pre-filter before the expensive Quality (Wayback+Ahrefs)
pillar: if the AI judge is highly confident the domain dropped + was
re-registered (not just transferred between owners), the operator can
skip burning Ahrefs credits on it.

Provider model is interface + concrete impl so we can add WhoisXMLAPI /
DomainTools later without touching the fetcher or the AI judge. Today
WhoisFreaks is the only concrete provider.

Public entrypoints:
  `fetch_history(domain)` → list[WhoisRecord] sorted chronologically
  `compute_diff(records)` → structured signals dict for the AI prompt

See `models.CriterionResult` for verdict storage (reuse pattern — the
whois_history "criterion" lives alongside the Quality B/D/A/K/W/C
criteria) and `routers/analyze.py` for job-creation.
"""

from .base import WhoisProvider, WhoisRecord  # noqa: F401
from .diff import compute_diff  # noqa: F401
from .fetcher import fetch_history  # noqa: F401
