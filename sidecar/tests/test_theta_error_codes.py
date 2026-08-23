"""Retry classification must match Theta's published error-code table.

Source of truth:
https://http-docs.thetadata.us/Articles/Data-And-Requests/Values/Error-Codes.html

    429 OS_LIMIT        OS is throttling your requests            TRANSIENT
    470 GENERAL         A general error                          permanent
    471 PERMISSION      Account lacks the required permissions   permanent
    472 NO_DATA         No data found for the request            permanent
    473 INVALID_PARAMS  Parameters / syntax invalid              permanent
    474 DISCONNECTED    Connection lost to Theta Data MDDS       TRANSIENT
    475 TERMINAL_PARSE  Issue parsing the request once received  permanent
    476 WRONG_IP        IP differs from the first request's IP   permanent
    477 NO_PAGE_FOUND   Page does not exist or expired           permanent
    570 LARGE_REQUEST   Request asking for too much data         permanent
    571 SERVER_STARTING Server intentionally restarting          TRANSIENT
    572 UNCAUGHT_ERROR  Contact support                          permanent

The bug these pin: the client had 474 and 476 backwards. It retried 476
under the comment "Theta MDDS transient disconnect" — but 476 is WRONG_IP
and permanent — while 474, the actual transient disconnect, was not
retried at all. Separately, a blanket `500 <= code < 600` rule retried 570
and 572, both permanent.

Cost of getting this wrong, from the 2026-08-15..22 Sentry weekly report:
31.1k of 42.2k total errors (74%) came from two paired Theta issues on
/v2/hist/option/eod. Retrying a permanent failure three times triples the
event volume and the load on a Terminal that is already refusing.
"""

from __future__ import annotations

import pytest

from theta_client import _is_retryable_http

# (code, retryable, name) straight from the published table.
_OFFICIAL: tuple[tuple[int, bool, str], ...] = (
    (429, True, "OS_LIMIT"),
    (470, False, "GENERAL"),
    (471, False, "PERMISSION"),
    (472, False, "NO_DATA"),
    (473, False, "INVALID_PARAMS"),
    (474, True, "DISCONNECTED"),
    (475, False, "TERMINAL_PARSE"),
    (476, False, "WRONG_IP"),
    (477, False, "NO_PAGE_FOUND"),
    (570, False, "LARGE_REQUEST"),
    (571, True, "SERVER_STARTING"),
    (572, False, "UNCAUGHT_ERROR"),
)


@pytest.mark.parametrize(("code", "retryable", "name"), _OFFICIAL)
def test_matches_thetas_published_table(code: int, retryable: bool, name: str) -> None:
    assert _is_retryable_http(code) is retryable, (
        f"HTTP {code} ({name}) should be "
        f"{'retryable' if retryable else 'permanent'} per Theta's error-code docs"
    )


def test_474_and_476_are_not_swapped() -> None:
    """The specific regression: 474 DISCONNECTED is the transient one;
    476 WRONG_IP is permanent. The client previously had these reversed."""
    assert _is_retryable_http(474) is True, "474 DISCONNECTED is transient"
    assert _is_retryable_http(476) is False, "476 WRONG_IP is permanent"


def test_permanent_5xx_are_not_blanket_retried() -> None:
    """A `500 <= code < 600` rule wrongly sweeps in 570 and 572."""
    assert _is_retryable_http(570) is False, "570 LARGE_REQUEST is permanent"
    assert _is_retryable_http(572) is False, "572 UNCAUGHT_ERROR is permanent"
    # …but a genuine transient 5xx still retries.
    assert _is_retryable_http(571) is True, "571 SERVER_STARTING is transient"


@pytest.mark.parametrize("code", [500, 502, 503, 504])
def test_generic_5xx_still_retry(code: int) -> None:
    """Codes outside Theta's table are ordinary HTTP server errors and stay
    retryable — the Terminal is a local jar behind a normal HTTP stack."""
    assert _is_retryable_http(code) is True


@pytest.mark.parametrize("code", [200, 400, 401, 403, 404])
def test_non_theta_4xx_never_retry(code: int) -> None:
    assert _is_retryable_http(code) is False
