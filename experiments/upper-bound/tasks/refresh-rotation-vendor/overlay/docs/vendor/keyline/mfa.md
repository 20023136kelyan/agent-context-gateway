# Multi-factor authentication

TOTP and WebAuthn are supported. When MFA is required, the password grant returns `mfa_required` and an `mfa_token`. Complete it at `POST /oauth/mfa` with the code or assertion. Recovery codes are single-use.
