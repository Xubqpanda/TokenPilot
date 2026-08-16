"""
fws lifecycle helpers for GWS/GitHub benchmark tasks.
"""

from __future__ import annotations

import logging
import os
import shutil
import socket
import subprocess
import time
from pathlib import Path
from typing import Dict, Optional


logger = logging.getLogger(__name__)

MOCK_SERVICE_ENV_KEYS = [
    "GOOGLE_WORKSPACE_CLI_CONFIG_DIR",
    "GOOGLE_WORKSPACE_CLI_TOKEN",
    "HTTPS_PROXY",
    "SSL_CERT_FILE",
    "GH_TOKEN",
    "GH_REPO",
]


def _fws_port() -> int:
    raw = os.environ.get("PINCHBENCH_FWS_PORT", "4100").strip()
    try:
        port = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"PINCHBENCH_FWS_PORT must be an integer, got {raw!r}") from exc
    if not 1 <= port <= 65534:
        raise RuntimeError(f"PINCHBENCH_FWS_PORT out of range: {port}")
    return port


def is_fws_task(frontmatter: dict) -> bool:
    category = str(frontmatter.get("category") or "").strip().lower()
    if category in {"gws", "github"}:
        return True
    prerequisites = frontmatter.get("prerequisites") or []
    return any("fws" in str(item).lower() for item in prerequisites)


def _candidate_binaries(name: str) -> list[str]:
    candidates = [name]
    home = Path.home()
    candidates.append(str(home / ".local" / "bin" / name))
    return candidates


def resolve_binary(name: str) -> Optional[str]:
    for candidate in _candidate_binaries(name):
        resolved = shutil.which(candidate) if os.path.sep not in candidate else candidate
        if resolved and os.path.exists(resolved):
            return resolved
    return None


def fws_available() -> bool:
    return resolve_binary("fws") is not None


def _wait_for_fws(port: int, timeout_s: float = 8.0) -> bool:
    """Wait for both the mock API and its CONNECT proxy to accept traffic."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        api_ready = proxy_ready = False
        for candidate, marker in ((port, "api"), (port + 1, "proxy")):
            try:
                with socket.create_connection(("127.0.0.1", candidate), timeout=0.4):
                    if marker == "api":
                        api_ready = True
                    else:
                        proxy_ready = True
            except OSError:
                pass
        if api_ready and proxy_ready:
            return True
        time.sleep(0.2)
    return False


def _release_fws_ports(port: int) -> None:
    """Release the two ports reserved exclusively for this benchmark worker."""
    fuser = shutil.which("fuser")
    if not fuser:
        return
    subprocess.run(
        [fuser, "-k", "-KILL", f"{port}/tcp", f"{port + 1}/tcp"],
        capture_output=True,
        text=True,
        check=False,
    )
    time.sleep(0.3)


def start_fws() -> Dict[str, Optional[str]]:
    fws_bin = resolve_binary("fws")
    if not fws_bin:
        raise RuntimeError("fws binary not found in PATH or ~/.local/bin")

    os.environ.setdefault("FWS_DATA_DIR", str(Path.home() / ".fws-data"))
    port = _fws_port()
    data_dir = Path(os.environ["FWS_DATA_DIR"])

    logger.info("Starting fws server via %s on port %s", fws_bin, port)
    # FWS occasionally reports success before its CONNECT proxy is listening.
    # Retry the isolated worker's daemon rather than failing an entire suite.
    max_attempts = int(os.environ.get("PINCHBENCH_FWS_START_ATTEMPTS", "3"))
    result: subprocess.CompletedProcess[str] | None = None
    for attempt in range(1, max_attempts + 1):
        # `server.json` is scoped by FWS_DATA_DIR, so this only stops a server
        # owned by the current benchmark worker.
        subprocess.run([fws_bin, "server", "stop"], capture_output=True, text=True, check=False)
        # A failed FWS start can leave its CONNECT proxy alive on port+1 while
        # losing the state needed by `server stop`. These ports are unique to
        # this worker, so release both before every retry.
        _release_fws_ports(port)
        result = subprocess.run(
            [fws_bin, "server", "start", "-p", str(port)],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
        if result.returncode == 0 and _wait_for_fws(port, timeout_s=15.0):
            break
        logger.warning("fws attempt %s/%s did not become ready on ports %s/%s", attempt, max_attempts, port, port + 1)
        if attempt == max_attempts:
            break
        time.sleep(float(attempt))

    assert result is not None
    original_env: Dict[str, Optional[str]] = {}
    injected = 0
    for raw_line in result.stdout.splitlines():
        line = raw_line.strip()
        if line.startswith("export "):
            line = line[7:]
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key not in MOCK_SERVICE_ENV_KEYS:
            continue
        value = value.strip().strip('"').strip("'")
        original_env[key] = os.environ.get(key)
        os.environ[key] = value
        injected += 1

    # Current FWS versions print shell hints rather than `export` lines. Set
    # the same variables directly so every isolated worker uses its own mock
    # service port and CA bundle.
    explicit_values = {
        "GOOGLE_WORKSPACE_CLI_CONFIG_DIR": str(data_dir / "config"),
        "GOOGLE_WORKSPACE_CLI_TOKEN": "fake",
        "HTTPS_PROXY": f"http://localhost:{port + 1}",
        "SSL_CERT_FILE": str(data_dir / "certs" / "ca-bundle.crt"),
        "GH_TOKEN": "fake",
    }
    for key, value in explicit_values.items():
        if key not in original_env:
            original_env[key] = os.environ.get(key)
            os.environ[key] = value
            injected += 1

    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        stdout = (result.stdout or "").strip()
        detail = stderr or stdout or f"exit_code={result.returncode}"
        raise RuntimeError(f"fws server start failed: {detail}")
    if not _wait_for_fws(port, timeout_s=1.0):
        raise RuntimeError(f"fws server did not become ready on ports {port}/{port + 1}")
    if injected == 0:
        logger.warning("fws started but no environment variables were parsed from stdout")
    return original_env


def stop_fws(original_env: Dict[str, Optional[str]] | None) -> None:
    fws_bin = resolve_binary("fws")
    if fws_bin:
        # The FWS state file is scoped by FWS_DATA_DIR, so this cannot stop a
        # server belonging to another isolated benchmark worker.
        subprocess.run([fws_bin, "server", "stop"], capture_output=True, text=True, check=False)
    if not original_env:
        return
    for key, value in original_env.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value
