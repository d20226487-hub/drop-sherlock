"""Domain-availability cascade — RDAP-first, with DNS pre-check + Domainr
and WHOIS fallbacks. Single-user, drop-hunting workflow.

Public entrypoint: `cascade.check_availability(domain)` returns the
final result + writes one history row per provider that responded.

See models.AvailabilityCheck for the row shape and routers/availability.py
for the HTTP surface.
"""

from .cascade import (  # noqa: F401
    AvailabilityResult,
    check_availability,
    check_availability_async,
)
