"""
A stand-in for the garminconnect library, for test/login.test.mjs and the screenshots of the login
card: it never talks to Garmin. The e-mail decides what happens:

  ok@example.com        logs in at once (password "Spravne-heslo-1")
  mfa@example.com       asks for a one-time code, 123456 is the right one
  limit@example.com     "too many requests"
  anything else         wrong e-mail or password

Its errors carry the password on purpose: the worker must never print an error text.
"""
import json
import os
import time

RIGHT_PASSWORD = "Spravne-heslo-1"
RIGHT_CODE = "123456"


class GarminConnectConnectionError(Exception):
    pass


class GarminConnectTooManyRequestsError(Exception):
    pass


class GarminConnectAuthenticationError(Exception):
    pass


class GarminConnectNotFoundError(Exception):
    pass


class _Client:
    def dump(self, path):
        with open(os.path.join(path, "garmin_tokens.json"), "w", encoding="utf-8") as f:
            json.dump({"di_token": "fake-di-token", "di_refresh_token": "fake-refresh"}, f)


class Garmin:
    def __init__(self, email=None, password=None, return_on_mfa=False, prompt_mfa=None, **_):
        self.username = email
        self.password = password
        self.return_on_mfa = return_on_mfa
        self.client = _Client()
        self.full_name = None
        self._pending = False
        time.sleep(float(os.environ.get("FAKE_GARMIN_DELAY", "0")))

    def login(self, tokenstore=None):
        if self.username == "limit@example.com":
            raise GarminConnectTooManyRequestsError("429 for " + str(self.password))
        if self.username == "mfa@example.com" and self.password == RIGHT_PASSWORD:
            self._pending = True
            return "needs_mfa", {"cookies": ["secret-cookie"]}
        if self.username == "ok@example.com" and self.password == RIGHT_PASSWORD:
            return None, None
        raise GarminConnectAuthenticationError("401 Unauthorized, password was " + str(self.password))

    def resume_login(self, state, code):
        if not self._pending:
            raise GarminConnectAuthenticationError("no pending login")
        if code != RIGHT_CODE:
            raise GarminConnectAuthenticationError("Widget MFA failed for code " + code)
        self._pending = False
        self.full_name = "Test Bežec"
        return None, None

    def _load_profile_and_settings(self):
        self.full_name = "Test Bežec"

    def get_full_name(self):
        return self.full_name
