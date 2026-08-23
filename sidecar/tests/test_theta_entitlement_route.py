"""Tests for GET /admin/theta-entitlements wired into HealthHandler.

Drives HealthHandler through a fake request socket — the same pattern as
test_theta_backfill_routes.py — so no HTTP server, Theta Terminal or
Postgres is involved.

The auth matrix is the point of the first section: every rejection path must
produce a byte-identical 401, or the admin surface becomes an enumeration
oracle. This mirrors _handle_seed_archive and the theta-backfill routes.
"""

from __future__ import annotations

import io
import json
import os
import sys
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("DATABENTO_API_KEY", "test-key")
os.environ.setdefault("DATABASE_URL", "postgresql://test:" + "fakefixture" + "@localhost/test")

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import pytest

from health import HealthHandler

_TOKEN = "test-admin-token"
_AUTH = {"X-Admin-Token": _TOKEN}
_PATH = "/admin/theta-entitlements"
_UNAUTHORIZED = {"error": "unauthorized"}


def _get(headers: dict[str, str] | None = None, *, path: str = _PATH) -> tuple[int, dict]:
    output = io.BytesIO()
    header_lines = "Host: localhost\r\n"
    for key, value in (headers or {}).items():
        header_lines += f"{key}: {value}\r\n"
    raw = f"GET {path} HTTP/1.1\r\n{header_lines}\r\n".encode()

    class _H(HealthHandler):
        # Production wires this via start_health_server(); without it the
        # admin gate refuses (correctly) before the token is even checked.
        theta_is_running = staticmethod(lambda: True)

        def setup(self_inner) -> None:  # noqa: N805
            self_inner.rfile = io.BytesIO(raw)
            self_inner.wfile = output

        def finish(self_inner) -> None:  # noqa: N805
            pass

        def log_message(self_inner, *_a: object, **_kw: object) -> None:  # noqa: N805
            pass

    _H(object(), ("127.0.0.1", 0), None)  # type: ignore[arg-type]
    text = output.getvalue().decode()
    status = int(text.split("\r\n", 1)[0].split()[1])
    _, _, body = text.partition("\r\n\r\n")
    if not body:
        return status, {}
    try:
        return status, json.loads(body)
    except json.JSONDecodeError:
        return status, {"_raw": body}


# ── auth matrix: every rejection is a byte-identical 401 ────────────────────


@pytest.mark.parametrize(
    "headers",
    [None, {"X-Admin-Token": "wrong"}, {"X-Admin-Token": ""}],
    ids=["no-header", "wrong-token", "empty-token"],
)
def test_every_rejection_is_an_identical_401(headers: dict[str, str] | None) -> None:
    with patch.dict(os.environ, {"ARCHIVE_SEED_TOKEN": _TOKEN}):
        status, body = _get(headers)
    assert status == 401
    assert body == _UNAUTHORIZED


def test_unset_server_token_also_401s_and_never_probes() -> None:
    """An unset ARCHIVE_SEED_TOKEN must not make the route open."""
    with (
        patch.dict(os.environ, {"ARCHIVE_SEED_TOKEN": ""}),
        patch("theta_entitlement_probe.probe_entitlements") as probe,
    ):
        status, body = _get(_AUTH)
    assert status == 401
    assert body == _UNAUTHORIZED
    probe.assert_not_called()


def test_unwired_theta_reporters_401s_identically() -> None:
    """A partially-wired server (no Theta) must not expose this endpoint —
    and must be indistinguishable from a bad token, so the admin surface is
    never an enumeration oracle."""
    output = io.BytesIO()
    raw = f"GET {_PATH} HTTP/1.1\r\nHost: localhost\r\nX-Admin-Token: {_TOKEN}\r\n\r\n".encode()

    class _Unwired(HealthHandler):
        theta_is_running = None

        def setup(self_inner) -> None:  # noqa: N805
            self_inner.rfile = io.BytesIO(raw)
            self_inner.wfile = output

        def finish(self_inner) -> None:  # noqa: N805
            pass

        def log_message(self_inner, *_a: object, **_kw: object) -> None:  # noqa: N805
            pass

    with patch.dict(os.environ, {"ARCHIVE_SEED_TOKEN": _TOKEN}):
        _Unwired(object(), ("127.0.0.1", 0), None)  # type: ignore[arg-type]
    text = output.getvalue().decode()
    assert int(text.split("\r\n", 1)[0].split()[1]) == 401
    assert json.loads(text.partition("\r\n\r\n")[2]) == _UNAUTHORIZED


# ── behaviour ──────────────────────────────────────────────────────────────


def test_authorized_probe_returns_the_report() -> None:
    report = {
        "root": "SPXW",
        "entitled": True,
        "results": [
            {
                "path": "/v2/bulk_snapshot/option/greeks_second_order",
                "why": "vanna + charm",
                "status": "ok",
                "fields": ["gamma", "vanna", "charm"],
                "error": None,
            }
        ],
    }
    with (
        patch.dict(os.environ, {"ARCHIVE_SEED_TOKEN": _TOKEN}),
        patch("theta_client.ThetaClient"),
        patch("theta_entitlement_probe.probe_entitlements", return_value=report),
    ):
        status, body = _get(_AUTH)
    assert status == 200
    assert body["entitled"] is True
    assert body["results"][0]["fields"] == ["gamma", "vanna", "charm"]


def test_probes_spxw_and_takes_no_query_string() -> None:
    """_ADMIN_GET_ROUTES matches the path EXACTLY, so a query string cannot
    reach the handler — it 404s. The route is therefore parameterless and
    always probes SPXW, the primary 0DTE chain. Entitlement is a property of
    the tier, not the ticker, so one root settles the question."""
    with (
        patch.dict(os.environ, {"ARCHIVE_SEED_TOKEN": _TOKEN}),
        patch("theta_client.ThetaClient"),
        patch(
            "theta_entitlement_probe.probe_entitlements",
            return_value={"root": "SPXW", "entitled": True, "results": []},
        ) as probe,
    ):
        status, _ = _get(_AUTH)
        assert status == 200
        assert probe.call_args.args[1] == "SPXW"

        # A query string is not silently accepted — it does not route.
        probe.reset_mock()
        status, _ = _get(_AUTH, path=f"{_PATH}?root=SPY")
        assert status == 404
        probe.assert_not_called()


def test_a_probe_failure_answers_500_rather_than_hanging() -> None:
    """The handler shares a process with /health; it must always respond."""
    with (
        patch.dict(os.environ, {"ARCHIVE_SEED_TOKEN": _TOKEN}),
        patch("theta_client.ThetaClient", side_effect=RuntimeError("terminal down")),
    ):
        status, body = _get(_AUTH)
    assert status == 500
    assert "terminal down" in body["error"]


def test_exact_path_match_only() -> None:
    """A prefix match would route /admin/theta-entitlements-typo here."""
    with patch.dict(os.environ, {"ARCHIVE_SEED_TOKEN": _TOKEN}):
        status, _ = _get(_AUTH, path=f"{_PATH}-typo")
    assert status == 404
