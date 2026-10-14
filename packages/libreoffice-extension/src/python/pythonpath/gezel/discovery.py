"""Find the running Gezel daemon the way every native client does: the
port and the per-launch certificate it publishes under its home."""

from __future__ import annotations

import os
import socket
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


def candidate_homes(env=None, user_dir=None) -> list:
    """Where this account's Gezel may keep its runtime: GEZEL_HOME alone when
    set; otherwise the installed app's ~/.gezel, then ~/.gezel-dev, where a
    development build of the desktop app runs. LibreOffice is started without
    GEZEL_HOME, so without the second entry a development Gezel was
    unreachable ("Gezel is not running") while it was plainly running."""
    env = os.environ if env is None else env
    home = env.get("GEZEL_HOME")
    if home:
        return [home]
    base = user_dir or os.path.expanduser("~")
    return [os.path.join(base, ".gezel"), os.path.join(base, ".gezel-dev")]


def _published_port(home):
    try:
        with open(os.path.join(home, "runtime", "port"), encoding="utf-8") as f:
            port = int(f.read().strip())
    except (OSError, ValueError):
        return None
    return port if 0 < port < 65536 else None


def _answers(port, timeout=0.3) -> bool:
    """Something is listening on the port. A port file can outlive its
    daemon, so its presence alone does not choose a home."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


def gezel_home(env=None, answers=_answers, user_dir=None) -> str:
    """The home of the Gezel this panel should talk to. Among candidates whose
    daemon is answering, the one that installed this extension (it keeps its
    setup record under integrations/libreoffice/) wins, then the first; with
    none answering, the first candidate, so the panel can say Gezel is not
    running. Resolve it again before each connect: Gezel may have started,
    or stopped, since the panel opened."""
    candidates = candidate_homes(env, user_dir)
    if len(candidates) == 1:
        return candidates[0]
    live = []
    for home in candidates:
        port = _published_port(home)
        if port is not None and answers(port):
            live.append(home)
    for home in live:
        if os.path.isfile(os.path.join(home, "integrations", "libreoffice", "setup.json")):
            return home
    return live[0] if live else candidates[0]


def read_owner_token(home=None):
    """The daemon's owner credential from this account's runtime directory,
    or None. Only this account can read it, which is what makes the reader
    the owner."""
    home = home or gezel_home()
    try:
        with open(os.path.join(home, "runtime", "auth-token"), encoding="utf-8") as f:
            return f.read().strip() or None
    except OSError:
        return None


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
