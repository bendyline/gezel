"""Find the running Gezel daemon the way every native client does: the
port and the per-launch certificate it publishes under its home."""

from __future__ import annotations

import os
from dataclasses import dataclass


class DaemonNotRunning(Exception):
    """No readable runtime/port: Gezel is not running for this account."""


@dataclass(frozen=True)
class Endpoint:
    host: str
    port: int
    scheme: str
    cert_path: str | None

    @property
    def base_url(self) -> str:
        return f"{self.scheme}://{self.host}:{self.port}"


def gezel_home(env=None) -> str:
    env = os.environ if env is None else env
    home = env.get("GEZEL_HOME")
    if home:
        return home
    return os.path.join(os.path.expanduser("~"), ".gezel")


def discover(home=None) -> Endpoint:
    """Read runtime/port and runtime/cert.pem. No cert means plain HTTP
    (a daemon started with GEZEL_INSECURE_TRANSPORT)."""
    home = home or gezel_home()
    runtime = os.path.join(home, "runtime")
    try:
        with open(os.path.join(runtime, "port"), encoding="utf-8") as f:
            port = int(f.read().strip())
    except (OSError, ValueError) as err:
        raise DaemonNotRunning(f"Gezel is not running (no port under {runtime}).") from err
    if not 0 < port < 65536:
        raise DaemonNotRunning(f"Gezel published an invalid port: {port}.")
    cert = os.path.join(runtime, "cert.pem")
    if os.path.isfile(cert):
        return Endpoint("127.0.0.1", port, "https", cert)
    return Endpoint("127.0.0.1", port, "http", None)
