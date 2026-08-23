"""Read-only probe that answers: does our Theta tier serve greeks + OI?

Why this exists
---------------
The sidecar calls exactly five Theta endpoints — `/v2/hist/option/eod`,
`/v2/hist/index/ohlc`, `/v2/snapshot/index/price`, `/v2/list/expirations`,
`/v2/list/strikes`. None returns greeks or open interest, yet the account
carries an Options **Pro** entitlement.

Theta publishes `/v2/bulk_snapshot/option/{all_greeks,greeks_second_order,
open_interest}` — whole-chain snapshots that include vanna and charm, marked
"Pro" in their docs. Those are precisely the OI-weighted greek inputs GexBot
derives its schema from, so if our credentials serve them we can compute that
schema ourselves instead of subscribing to GexBot at $250/mo.

`docs/superpowers/specs/gexbot-trial-capture-2026-05-16.md` framed the
end-state as "cancel + self-compute permanently", conditional on being able
to reverse-engineer the formulas. A second independent greek source is what
makes that verifiable rather than guesswork.

The probe is deliberately inert: it performs GETs, writes nothing, and
reports per-endpoint reachability so the entitlement question is settled with
evidence rather than by reading a pricing page.
"""

from __future__ import annotations

import json

import pytest

from theta_client import ThetaClient, ThetaSubscriptionError
from theta_entitlement_probe import PROBE_ENDPOINTS, probe_entitlements


def _ok(payload: dict) -> object:
    """Minimal stand-in for ThetaClient._get_json's parsed return."""
    return payload


class _FakeClient:
    """Records the paths probed and replays a scripted outcome per path."""

    def __init__(self, outcomes: dict[str, object]) -> None:
        self.outcomes = outcomes
        self.calls: list[tuple[str, dict]] = []

    def _get_json(self, path: str, params: dict) -> dict:
        self.calls.append((path, params))
        out = self.outcomes.get(path)
        if isinstance(out, Exception):
            raise out
        return out if out is not None else {}


def test_probes_the_three_endpoints_that_settle_the_question() -> None:
    """all_greeks, greeks_second_order (vanna/charm) and open_interest."""
    paths = [e.path for e in PROBE_ENDPOINTS]
    assert "/v2/bulk_snapshot/option/all_greeks" in paths
    assert "/v2/bulk_snapshot/option/greeks_second_order" in paths
    assert "/v2/bulk_snapshot/option/open_interest" in paths


def test_reports_entitled_when_the_endpoint_returns_a_payload() -> None:
    client = _FakeClient(
        {
            e.path: _ok({"header": {"format": ["gamma", "vanna", "charm"]}, "response": [[1]]})
            for e in PROBE_ENDPOINTS
        }
    )
    out = probe_entitlements(client, root="SPXW")

    assert out["entitled"] is True
    for r in out["results"]:
        assert r["status"] == "ok", r
        # The format header is the useful artifact — it names the fields the
        # tier actually serves, which is what a self-compute build needs.
        assert r["fields"] == ["gamma", "vanna", "charm"]


def test_a_471_is_reported_as_not_entitled_not_as_a_crash() -> None:
    """471 = PERMISSION. That is the real answer to "are we entitled?"."""
    denied = ThetaSubscriptionError("Theta denied request (HTTP 471)")
    client = _FakeClient({e.path: denied for e in PROBE_ENDPOINTS})

    out = probe_entitlements(client, root="SPXW")

    assert out["entitled"] is False
    assert all(r["status"] == "denied" for r in out["results"])
    assert all("471" in (r["error"] or "") for r in out["results"])


def test_no_data_is_entitled_but_empty() -> None:
    """472 = NO_DATA is coerced to {} upstream. Access is fine; the chain
    is simply empty (weekend, dead root). Must NOT read as a denial —
    conflating the two is the exact bug that cost two Theta tier upgrades."""
    client = _FakeClient({e.path: {} for e in PROBE_ENDPOINTS})

    out = probe_entitlements(client, root="SPXW")

    assert out["entitled"] is True
    assert all(r["status"] == "no_data" for r in out["results"])


def test_mixed_outcome_is_entitled_if_any_endpoint_answers() -> None:
    outcomes: dict[str, object] = {e.path: ThetaSubscriptionError("471") for e in PROBE_ENDPOINTS}
    outcomes["/v2/bulk_snapshot/option/open_interest"] = {
        "header": {"format": ["open_interest"]},
        "response": [[123]],
    }
    out = probe_entitlements(_FakeClient(outcomes), root="SPXW")

    assert out["entitled"] is True
    by_path = {r["path"]: r for r in out["results"]}
    assert by_path["/v2/bulk_snapshot/option/open_interest"]["status"] == "ok"
    assert by_path["/v2/bulk_snapshot/option/all_greeks"]["status"] == "denied"


def test_unexpected_errors_are_captured_never_raised() -> None:
    """A probe must never take the process down — it runs behind an admin
    route on the same server that serves /health."""
    client = _FakeClient({e.path: RuntimeError("socket exploded") for e in PROBE_ENDPOINTS})

    out = probe_entitlements(client, root="SPXW")

    assert out["entitled"] is False
    assert all(r["status"] == "error" for r in out["results"])
    assert all("socket exploded" in (r["error"] or "") for r in out["results"])


def test_uses_exp_zero_to_sweep_every_expiration() -> None:
    """Theta's docs: exp=0 snapshots every expiration chain for the root."""
    client = _FakeClient({e.path: {} for e in PROBE_ENDPOINTS})
    probe_entitlements(client, root="SPXW")

    for _path, params in client.calls:
        assert params["root"] == "SPXW"
        assert params["exp"] == 0


def test_result_is_json_serialisable() -> None:
    """It is returned straight out of an HTTP handler."""
    client = _FakeClient({e.path: {} for e in PROBE_ENDPOINTS})
    json.dumps(probe_entitlements(client, root="SPXW"))


def test_probe_writes_nothing() -> None:
    """Read-only by construction: the fake exposes only _get_json, so any
    attempt to persist would raise AttributeError."""
    client = _FakeClient({e.path: {} for e in PROBE_ENDPOINTS})
    probe_entitlements(client, root="SPXW")
    assert not hasattr(client, "insert")
    assert len(client.calls) == len(PROBE_ENDPOINTS)


def test_real_client_satisfies_the_shape_the_probe_needs() -> None:
    """Guards against drift between ThetaClient and the probe's expectation."""
    assert hasattr(ThetaClient, "_get_json")


@pytest.mark.parametrize("bad_root", ["", "   "])
def test_blank_root_is_rejected(bad_root: str) -> None:
    client = _FakeClient({e.path: {} for e in PROBE_ENDPOINTS})
    with pytest.raises(ValueError, match="root"):
        probe_entitlements(client, root=bad_root)
