"""Private-suffix ("double domain") detection for the availability
cascade.

A *double domain* is one registered under a multi-label suffix that the
standard gTLD/ccTLD RDAP + WHOIS infrastructure can't authoritatively
check. The canonical example is ``jcg.us.com``: ``us.com`` is a
CentralNic reseller registry sold *under* the real ``.com`` gTLD.
Querying Verisign's ``.com`` RDAP for ``jcg.us.com`` returns "not
found", which the cascade would otherwise read as AVAILABLE — a
dangerous false positive, because the name is in fact taken at the
``us.com`` registry. The operator then wastes Ahrefs units analysing a
domain they can never actually register.

We can't reliably check these, so we mark them ``not_supported`` and
short-circuit the cascade (no provider calls, no Ahrefs spend) rather
than guessing.

Detection uses the Public Suffix List's two sections:

  * The full list (ICANN + PRIVATE) resolves ``jcg.us.com`` → ``us.com``.
  * The ICANN-only list resolves it → ``com``.

When those differ, the registration lives under a PRIVATE suffix and is
unverifiable → flag it. ICANN-delegated multi-label ccTLD suffixes
(``co.uk``, ``com.br``, ``com.au`` …) resolve identically under both
lists, so they are **not** flagged — they go through the normal cascade
where their own registry RDAP/WHOIS works correctly. This keeps us free
of both false positives (us.com mis-read as available) and false
negatives (co.uk wrongly refused).

``publicsuffixlist`` bundles a dated PSL snapshot inside the wheel, so
there is no network fetch at runtime.
"""
from __future__ import annotations

from functools import lru_cache

from publicsuffixlist import PublicSuffixList


@lru_cache(maxsize=1)
def _full_psl() -> PublicSuffixList:
    """ICANN + PRIVATE sections (the default)."""
    return PublicSuffixList()


@lru_cache(maxsize=1)
def _icann_psl() -> PublicSuffixList:
    """ICANN section only — private reseller suffixes excluded."""
    return PublicSuffixList(only_icann=True)


def is_private_suffix_domain(domain: str) -> bool:
    """True when `domain` is registered under a PRIVATE PSL suffix that
    the cascade can't authoritatively check (see module docstring).

    Returns False for ordinary gTLD/ccTLD domains, deep subdomains of a
    normal registrable domain (``a.b.example.com`` → suffix ``com`` under
    both lists), and unknown TLDs (let the cascade try those — we never
    want a false `not_supported`).
    """
    if not domain or "." not in domain:
        return False
    # accept_unknown=False → unknown TLDs return None (both lists agree),
    # so a brand-new gTLD missing from the bundled snapshot is NOT flagged.
    full = _full_psl().publicsuffix(domain, accept_unknown=False)
    icann = _icann_psl().publicsuffix(domain, accept_unknown=False)
    if full is None or icann is None:
        return False
    return full != icann
