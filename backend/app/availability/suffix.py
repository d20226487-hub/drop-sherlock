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


def registrable_domain(raw: str) -> str:
    """Reduce a raw input (URL, host, or bare domain) to its registrable
    domain (eTLD+1) — the only unit an availability check is meaningful for
    (a subdomain isn't independently registrable; the registry RDAP/WHOIS
    404s it, which the cascade would mis-read as a false `available`).

    Strips scheme / userinfo / path / query / port + a leading `www.`,
    lowercases, then resolves eTLD+1 via the bundled PSL with the PRIVATE
    section included. So `https://www.shop.example.co.uk/x?y=1` ->
    `example.co.uk`, while a private-suffix registration like `jcg.us.com`
    is preserved WHOLE (not collapsed to `us.com`, which would be wrong and
    would defeat the `is_private_suffix_domain` guard downstream).

    Returns "" for empty/garbage input. Falls back to the cleaned host when
    the PSL can't resolve a registrable domain (a new gTLD missing from the
    bundled snapshot, a bare TLD, an IP literal, `localhost`) — passing the
    host to the cascade is better than silently dropping the operator's
    input, and matches the "never a false not_supported on unknown TLDs"
    stance of the guards below."""
    s = (raw or "").strip().lower()
    if not s:
        return ""
    if "://" in s:
        s = s.split("://", 1)[1]
    s = s.split("/", 1)[0]      # drop path
    s = s.split("?", 1)[0]      # drop a query with no path
    s = s.split("@")[-1]        # drop userinfo (user:pass@host)
    s = s.split(":", 1)[0]      # drop port
    s = s.strip().strip(".")    # surrounding dots (FQDN form)
    if s.startswith("www."):
        s = s[4:]
    if not s:
        return ""
    reg = _full_psl().privatesuffix(s, accept_unknown=False)
    return reg or s


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


def is_multilabel_public_suffix_domain(domain: str) -> bool:
    """True when `domain`'s ICANN public suffix has MORE THAN ONE label —
    a "double extension" like ``com.ua`` / ``net.uk`` / ``co.uk`` /
    ``com.br`` / ``com.au``.

    These are legitimate ICANN-delegated ccTLD second levels (NOT the
    private reseller suffixes `is_private_suffix_domain` flags), but RDAP
    coverage for them is patchy and inconsistent — many ccTLD registries
    either don't run RDAP for the second level or return answers the
    cascade mis-reads — so the orchestrator routes them to WhoisFreaks
    only (see cascade.py).

    Returns False for single-label TLDs (``example.ua`` → ``ua``,
    ``example.uk`` → ``uk``, ``example.com`` → ``com``), deep subdomains
    of a normal registrable domain (``a.b.example.com`` → ``com``), and
    unknown TLDs (suffix is None). Domains under a PRIVATE multi-label
    suffix resolve to a SINGLE-label ICANN suffix (``jcg.us.com`` →
    ``com``) so they are NOT flagged here — they're handled one phase
    earlier by `is_private_suffix_domain`.
    """
    if not domain or "." not in domain:
        return False
    icann = _icann_psl().publicsuffix(domain, accept_unknown=False)
    if not icann:
        return False
    return "." in icann
