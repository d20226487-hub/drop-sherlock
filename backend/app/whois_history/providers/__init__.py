"""Concrete WhoisProvider implementations. Only WhoisFreaks today;
WhoisXMLAPI / DomainTools / SecurityTrails can drop in as additional
files later without touching the fetcher."""

from .whoisfreaks import WhoisFreaksProvider  # noqa: F401
