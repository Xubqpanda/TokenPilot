import os
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from lib_fws import _fws_port, _release_fws_ports, _wait_for_fws


class FwsPortTests(unittest.TestCase):
    def test_reads_worker_port_from_environment(self):
        with patch.dict(os.environ, {"PINCHBENCH_FWS_PORT": "43120"}):
            self.assertEqual(_fws_port(), 43120)

    def test_rejects_invalid_or_unpairable_ports(self):
        for value in ("invalid", "0", "65535"):
            with self.subTest(value=value), patch.dict(
                os.environ,
                {"PINCHBENCH_FWS_PORT": value},
            ):
                with self.assertRaises(RuntimeError):
                    _fws_port()

    def test_readiness_checks_api_and_adjacent_proxy_port(self):
        connection = MagicMock()
        connection.__enter__.return_value = connection
        connection.__exit__.return_value = False

        with patch("lib_fws.socket.create_connection", return_value=connection) as connect:
            self.assertTrue(_wait_for_fws(43120, timeout_s=0.1))

        self.assertEqual(
            [call.args[0] for call in connect.call_args_list],
            [("127.0.0.1", 43120), ("127.0.0.1", 43121)],
        )

    def test_cleanup_targets_only_worker_port_pair(self):
        with (
            patch("lib_fws.shutil.which", return_value="/usr/bin/fuser"),
            patch("lib_fws.subprocess.run") as run,
            patch("lib_fws.time.sleep"),
        ):
            _release_fws_ports(43120)

        run.assert_called_once_with(
            ["/usr/bin/fuser", "-k", "-KILL", "43120/tcp", "43121/tcp"],
            capture_output=True,
            text=True,
            check=False,
        )


if __name__ == "__main__":
    unittest.main()
