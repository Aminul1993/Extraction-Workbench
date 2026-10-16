"""Signed launch tokens for the workbench.

When WORKBENCH_LAUNCH_SECRET is set, the API only answers requests that carry a valid,
unexpired token in their query string. The parent application mints one with the same secret
and opens the workbench at /?token=<token>; the page forwards its own query string to every API
call, so nothing else needs to change on the page.

The parent mints tokens with this module, or with itsdangerous directly:

    URLSafeTimedSerializer(secret, salt='extraction-workbench').dumps({'form_type': 'invoice'})

For local testing, `python launch_token.py` prints a token for the secret in api/.env.
"""
from typing import Any

from itsdangerous import URLSafeTimedSerializer

SALT = 'extraction-workbench'


def issue(secret: str, claims: dict[str, Any] | None = None) -> str:
    return URLSafeTimedSerializer(secret, salt=SALT).dumps(claims or {})


def verify(secret: str, token: str, max_age: int) -> Any:
    """Return the token's claims; raises itsdangerous.SignatureExpired or BadSignature."""
    return URLSafeTimedSerializer(secret, salt=SALT).loads(token, max_age=max_age)


if __name__ == '__main__':
    import os

    from dotenv import load_dotenv

    load_dotenv()
    secret = os.getenv('WORKBENCH_LAUNCH_SECRET')
    if not secret:
        raise SystemExit('Set WORKBENCH_LAUNCH_SECRET in api/.env first')
    print(issue(secret))
