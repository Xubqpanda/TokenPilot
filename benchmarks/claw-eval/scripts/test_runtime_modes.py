from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

_SCRIPT_ROOT = Path(__file__).parent


def _run_isolated_check(code: str, *args: str) -> None:
    subprocess.run(
        [sys.executable, "-c", code, str(_SCRIPT_ROOT), *args],
        check=True,
    )


def test_baseline_clears_tokenpilot_without_removing_other_plugins(tmp_path: Path) -> None:
    config_path = tmp_path / "openclaw.json"
    config_path.write_text(
        json.dumps(
            {
                "plugins": {
                    "enabled": True,
                    "allow": ["tokenpilot", "tavily-search"],
                    "entries": {
                        "tokenpilot": {"enabled": True},
                        "tavily-search": {"enabled": True},
                    },
                    "installs": {"tokenpilot": {"source": "local"}},
                    "load": {"paths": ["/home/user/.openclaw/extensions/tokenpilot", "/tmp/plugins"]},
                    "slots": {"contextEngine": "layered-context"},
                }
            }
        )
        + "\n",
        encoding="utf-8",
    )

    _run_isolated_check(
        """
import json
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from benchmark import _clear_tokenpilot_runtime_settings
config_path = Path(sys.argv[2])
result = _clear_tokenpilot_runtime_settings(config_path)
config = json.loads(config_path.read_text(encoding='utf-8'))
plugins = config['plugins']
assert result == {'tokenpilot_enabled': False, 'contextEngine': 'legacy'}
assert plugins['slots']['contextEngine'] == 'legacy'
assert 'tokenpilot' not in plugins.get('entries', {})
assert 'tokenpilot' not in plugins.get('installs', {})
assert plugins['allow'] == ['tavily-search']
assert plugins['load']['paths'] == ['/tmp/plugins']
assert 'tavily-search' in plugins['entries']
""",
        str(config_path),
    )


def test_runtime_mode_is_explicit_and_model_prefix_is_only_fallback() -> None:
    _run_isolated_check(
        """
import os
import sys
sys.path.insert(0, sys.argv[1])
from benchmark import _should_enable_tokenpilot_runtime
os.environ['TOKENPILOT_RUNTIME_ENABLED'] = 'false'
assert _should_enable_tokenpilot_runtime('tokenpilot/gpt-5.4-mini') is False
os.environ['TOKENPILOT_RUNTIME_ENABLED'] = 'true'
assert _should_enable_tokenpilot_runtime('gpt-5.4-mini') is True
""",
    )
