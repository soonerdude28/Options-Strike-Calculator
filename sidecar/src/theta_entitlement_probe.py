"""Answer, with evidence, whether our Theta tier serves greeks + open interest.

Background
----------
The sidecar calls five Theta endpoints and none of them returns greeks or
open interest, yet the account carries an Options **Pro** entitlement. Theta
publishes whole-chain bulk snapshots that do — including second-order greeks
(vanna, charm) — and their docs mark them "Pro".

Those are exactly the OI-weighted greek inputs GexBot derives its schema
from. GexBot is a paid third party whose key this fork never had, leaving
eight `gex_` columns NULL on every fire. If our existing Theta entitlement
already serves the raw inputs, that schema is computable in-house and the
$250/mo Orderflow tier buys nothing we cannot already produce — which is the
"cancel + self-compute permanently" branch of
``docs/superpowers/specs/gexbot-trial-capture-2026-05-16.md``.

More importantly, Theta would be a SECOND independent greek source alongside
UW's ``strike_exposures``. The reason a previous self-compute attempt was
rejected is that with ``gexbot_snapshots`` empty there was no way to verify
sign or scale. Two independent derivations that agree is stronger evidence
than one vendor's numbers taken on trust.

This module is deliberately inert: it performs GETs, writes nothing, and
never raises. It reports per-endpoint reachability so the entitlement
question is settled by observation rather than by reading a pricing page.

Interpreting the result
-----------------------
- ``ok``      — the endpoint answered with a payload. Entitled.
- ``no_data`` — answered, but the chain was empty. Theta HTTP 472 = NO_DATA,
  coerced to ``{}`` by ``ThetaClient._get_json``. This IS entitlement: it
  means access works and there is simply nothing to return (weekend, dead
  root). Conflating 472 with a denial is the exact bug that previously killed
  whole roots and prompted two unnecessary tier upgrades — see the 472/471
  handling in ``theta_client``.
- ``denied``  — HTTP 471 = PERMISSION. This is a real entitlement failure.
- ``error``   — anything else (transport, parse). Inconclusive, not a denial.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from theta_client import ThetaSubscriptionError


class _SupportsGetJson(Protocol):
    """The single method the probe needs from ThetaClient."""

    def _get_json(self, path: str, params: dict[str, Any]) -> dict[str, Any]: ...


@dataclass(frozen=True)
class ProbeEndpoint:
    """One Theta endpoint to test, and why it matters."""

    path: str
    why: str


# `exp=0` sweeps every expiration chain for the root (Theta's documented
# behaviour for the bulk snapshots), so one call per endpoint settles it.
PROBE_ENDPOINTS: tuple[ProbeEndpoint, ...] = (
    ProbeEndpoint(
        "/v2/bulk_snapshot/option/all_greeks",
        "delta/gamma/theta/vega per contract — the DEX and GEX inputs",
    ),
    ProbeEndpoint(
        "/v2/bulk_snapshot/option/greeks_second_order",
        "vanna + charm per contract — GexBot's zvanna/zcharm inputs",
    ),
    ProbeEndpoint(
        "/v2/bulk_snapshot/option/open_interest",
        "open interest per contract — the OI weighting every exposure needs",
    ),
)


def _fields_of(body: dict[str, Any]) -> list[str] | None:
    """Theta returns its column names in header.format. That list is the
    useful artifact: it names what the tier actually serves, which is what a
    self-compute build has to map against."""
    header = body.get("header")
    if not isinstance(header, dict):
        return None
    fmt = header.get("format")
    return [str(f) for f in fmt] if isinstance(fmt, list) else None


def probe_entitlements(
    client: _SupportsGetJson,
    root: str,
) -> dict[str, Any]:
    """GET each probe endpoint once and report what happened.

    Never raises on a probe failure — this runs behind an admin route on the
    same server that serves ``/health``, so a transport error must degrade to
    a reported status, not take the process down. The only exception is a
    caller-side ValueError for a blank root, which is a programming error.
    """
    if not root or not root.strip():
        raise ValueError("probe_entitlements: root must be a non-empty ticker")

    results: list[dict[str, Any]] = []
    for endpoint in PROBE_ENDPOINTS:
        entry: dict[str, Any] = {
            "path": endpoint.path,
            "why": endpoint.why,
            "status": "error",
            "fields": None,
            "error": None,
        }
        try:
            body = client._get_json(endpoint.path, {"root": root, "exp": 0})
        except ThetaSubscriptionError as exc:
            # 471 PERMISSION — the genuine "not entitled" signal.
            entry["status"] = "denied"
            entry["error"] = str(exc)
        except Exception as exc:  # noqa: BLE001 — a probe must never propagate
            entry["error"] = f"{type(exc).__name__}: {exc}"
        else:
            fields = _fields_of(body)
            # 472 NO_DATA arrives here as {} — access works, chain is empty.
            entry["status"] = "no_data" if not body else "ok"
            entry["fields"] = fields
        results.append(entry)

    # Entitled if ANY endpoint answered without a permission denial: a single
    # served endpoint proves the tier covers this family.
    entitled = any(r["status"] in ("ok", "no_data") for r in results)
    return {"root": root, "entitled": entitled, "results": results}
