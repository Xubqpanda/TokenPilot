#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from benchmark import (
    _apply_tokenpilot_runtime_settings,
    _available_provider_models,
    _default_service_code_root,
    _resolve_openclaw_config_path,
    _resolve_model_id,
    _synchronize_run_tool_allowlist,
)
from lib_agent import execute_task
from lib_grading import grade_execution_result
from lib_services import (
    activate_plugins_for_run,
    build_plugin_install_plan,
    cleanup_claw_eval_plugin_state,
    restore_plugins_after_run,
    summarize_plugin_closure,
)
from lib_tasks import ClawEvalTaskLoader


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="A/B evaluate distilled prompt injection with claw-eval graders")
    default_openclaw_home = (
        os.environ.get("TOKENPILOT_OPENCLAW_HOME")
        or str(Path.home())
    )
    parser.add_argument("--tasks-dir", default=str(Path(__file__).resolve().parents[1] / "dataset" / "tasks"))
    parser.add_argument("--suite", required=True, help="Comma-separated task ids to run")
    parser.add_argument("--model", required=True)
    parser.add_argument("--judge", default="tokenpilot/gpt-5.4-mini")
    parser.add_argument("--skill-file", required=True, help="Path to distilled_skill.json")
    parser.add_argument("--next-objective", required=True, help="Objective text used in the injected skill block")
    parser.add_argument("--output-dir", default=str(Path(__file__).resolve().parents[1] / "save" / "prompt_ab"))
    parser.add_argument(
        "--plugin-root",
        default=str(Path(__file__).resolve().parents[1] / "plugins"),
        help="Directory containing claw-eval mock-tool OpenClaw plugins",
    )
    parser.add_argument(
        "--openclaw-config-path",
        default=os.environ.get(
            "OPENCLAW_CONFIG_PATH",
            str(Path(default_openclaw_home) / ".openclaw" / "openclaw.json"),
        ),
    )
    parser.add_argument(
        "--source-openclaw-home",
        default=os.environ.get("SOURCE_OPENCLAW_HOME", str(Path.home())),
        help="Source home directory whose .openclaw state will be copied into a writable tmp home",
    )
    return parser.parse_args()


def unique_strings(values: list[Any]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = str(value or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
    return out


def build_injection_text(skill: dict[str, Any], next_objective: str) -> str:
    workflow = unique_strings(skill.get("workflow") or [])
    tool_patterns = unique_strings(skill.get("tool_patterns") or [])
    pitfalls = unique_strings(skill.get("pitfalls") or [])
    return "\n".join(
        line
        for line in [
            "[TokenPilot Procedural Memory]",
            "Use only if relevant to the current objective.",
            "Treat this as lightweight guidance, not a hard constraint.",
            "Continue solving the current task with the actual tool outputs in this run.",
            "If some data is missing or inconsistent, still provide the best concrete task completion you can, and mention uncertainty briefly only when it materially affects the answer.",
            f"Current objective: {next_objective}",
            f"Relevant objective type: {str(skill.get('objective') or '').strip()}",
            f"Suggested workflow: {' | '.join(workflow)}" if workflow else "",
            f"Tool use hints: {' | '.join(tool_patterns)}" if tool_patterns else "",
            f"Avoid these failure patterns only if they are actually relevant now: {' | '.join(pitfalls)}" if pitfalls else "",
            "Priority: finish the requested task accurately and concretely.",
        ]
        if line.strip()
    )


def run_shell(command: str) -> None:
    subprocess.run(command, shell=True, check=True)


def _pick_ephemeral_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def prepare_tmp_openclaw_home(source_home: Path, label: str) -> tuple[Path, Path, int, int]:
    source_state_dir = source_home / ".openclaw"
    if not source_state_dir.is_dir():
        raise SystemExit(f"Missing source OpenClaw state dir: {source_state_dir}")

    run_stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    tmp_home = Path("/tmp") / f"claw-eval-openclaw-{label}-{run_stamp}-{os.getpid()}"
    tmp_state = tmp_home / ".openclaw"
    tmp_home.mkdir(parents=True, exist_ok=True)
    subprocess.run(["cp", "-a", str(source_state_dir), str(tmp_state)], check=True)

    for child in (
        "tokenpilot-plugin-state",
        "logs",
        "completions",
        "canvas",
        "cron",
        "workspace",
        "agents",
    ):
        target = tmp_state / child
        if target.exists():
            subprocess.run(["rm", "-rf", str(target)], check=True)
    (tmp_state / "agents").mkdir(parents=True, exist_ok=True)

    config_path = tmp_state / "openclaw.json"
    gateway_port = _pick_ephemeral_port()
    proxy_port = _pick_ephemeral_port()
    raw = json.loads(config_path.read_text(encoding="utf-8"))
    raw.setdefault("gateway", {})["port"] = gateway_port
    plugins = raw.setdefault("plugins", {})
    entries = plugins.setdefault("entries", {})
    tokenpilot = entries.setdefault("tokenpilot", {})
    tokenpilot_cfg = tokenpilot.setdefault("config", {})
    tokenpilot_cfg["proxyPort"] = proxy_port
    config_path.write_text(json.dumps(raw, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    os.environ["TOKENPILOT_OPENCLAW_HOME"] = str(tmp_home)
    os.environ["OPENCLAW_CONFIG_PATH"] = str(config_path)
    os.environ["HOME"] = str(tmp_home)
    os.environ["XDG_CONFIG_HOME"] = str(tmp_home / ".config")
    os.environ.setdefault("XDG_CACHE_HOME", str(tmp_home / ".cache"))
    os.environ.setdefault("UV_CACHE_DIR", "/tmp/uv-cache")
    os.environ["TOKENPILOT_GATEWAY_PORT"] = str(gateway_port)
    Path(os.environ["XDG_CONFIG_HOME"]).mkdir(parents=True, exist_ok=True)
    Path(os.environ["XDG_CACHE_HOME"]).mkdir(parents=True, exist_ok=True)
    Path(os.environ["UV_CACHE_DIR"]).mkdir(parents=True, exist_ok=True)
    return tmp_home, config_path, gateway_port, proxy_port


def start_tmp_gateway(config_path: Path, gateway_port: int) -> subprocess.Popen[str]:
    env = os.environ.copy()
    proc = subprocess.Popen(
        ["openclaw", "gateway", "run", "--force", "--port", str(gateway_port)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
    )
    for _ in range(30):
        try:
            with socket.create_connection(("127.0.0.1", gateway_port), timeout=0.5):
                return proc
        except OSError:
            pass
        if proc.poll() is not None:
            output = proc.stdout.read() if proc.stdout else ""
            raise SystemExit(f"Failed to start OpenClaw gateway for {config_path}\n{output}")
        import time

        time.sleep(1)
    proc.terminate()
    output = proc.stdout.read() if proc.stdout else ""
    raise SystemExit(f"Timed out waiting for OpenClaw gateway\n{output}")


def main() -> None:
    args = parse_args()
    tasks_dir = Path(args.tasks_dir).resolve()
    output_root = Path(args.output_dir).resolve()
    source_home = Path(args.source_openclaw_home).expanduser().resolve()
    tmp_home, config_path, gateway_port, _proxy_port = prepare_tmp_openclaw_home(source_home, "prompt-ab")
    dataset_root = tasks_dir.parent
    service_code_root = _default_service_code_root()
    plugin_root = Path(args.plugin_root).resolve()

    loader = ClawEvalTaskLoader(tasks_dir)
    all_tasks = loader.load_all_tasks()
    selected = loader.select_tasks(all_tasks, args.suite)
    if not selected:
        raise SystemExit(f"No tasks matched suite={args.suite}")
    for task in selected:
        task.frontmatter["_dataset_root"] = str(dataset_root.resolve())

    all_declared_tools = sorted(
        {
            tool_name
            for task in all_tasks
            for tool_name in task.declared_tools
            if tool_name
        }
    )
    closure = summarize_plugin_closure(selected)
    install_plan = build_plugin_install_plan(selected, plugin_root)
    if install_plan.missing_plugin_ids:
        raise SystemExit(f"Missing plugin manifests for: {', '.join(install_plan.missing_plugin_ids)}")

    execution_model = _resolve_model_id(args.model, config_path, purpose="execution")
    judge_model = _resolve_model_id(args.judge, config_path, purpose="judge")
    if execution_model not in _available_provider_models(config_path):
        print(f"[warn] model {execution_model} not found in providers; relying on runtime/provider fallback")
    skill = json.loads(Path(args.skill_file).read_text(encoding="utf-8"))
    injection_text = build_injection_text(skill, args.next_objective)

    run_id = datetime.now(timezone.utc).strftime("run_%Y%m%d_%H%M%S")
    run_root = output_root / run_id
    run_root.mkdir(parents=True, exist_ok=True)
    (run_root / "injected_prompt.txt").write_text(injection_text + "\n", encoding="utf-8")
    (run_root / "meta.json").write_text(
        json.dumps(
            {
                "suite": args.suite,
                "required_plugins": closure["required_plugins"],
                "tmp_openclaw_home": str(tmp_home),
                "openclaw_config_path": str(config_path),
                "gateway_port": gateway_port,
                "execution_model": execution_model,
                "judge_model": judge_model,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    summary: list[dict[str, Any]] = []
    cleanup_done = False
    activation_plan = None
    gateway_proc = None

    def _cleanup() -> None:
        nonlocal cleanup_done
        if cleanup_done:
            return
        try:
            if activation_plan is not None and activation_plan.backup_path.exists():
                restore_plugins_after_run(activation_plan, config_path, runner=run_shell)
            cleanup_claw_eval_plugin_state(config_path, plugin_root, runner=run_shell)
        finally:
            if gateway_proc is not None and gateway_proc.poll() is None:
                gateway_proc.terminate()
                try:
                    gateway_proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    gateway_proc.kill()
            cleanup_done = True

    previous_sigint = signal.getsignal(signal.SIGINT)
    previous_sigterm = signal.getsignal(signal.SIGTERM)

    def _handle_signal(signum, _frame) -> None:
        _cleanup()
        raise SystemExit(128 + int(signum))

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)
    try:
        cleanup_claw_eval_plugin_state(config_path, plugin_root, runner=run_shell)
        activation_plan = activate_plugins_for_run(
            install_plan.required_plugins,
            plugin_root,
            config_path,
            runner=run_shell,
        )
        synchronized_tools = _synchronize_run_tool_allowlist(config_path, selected, all_declared_tools)
        runtime_patch = _apply_tokenpilot_runtime_settings(config_path, execution_model=execution_model)
        if synchronized_tools:
            print(f"[tools] allowlist={synchronized_tools}")
        if runtime_patch:
            print(f"[tokenpilot] runtime patch={runtime_patch}")
        gateway_proc = start_tmp_gateway(config_path, gateway_port)

        for variant_name, prompt_prefix in (
            ("baseline", None),
            ("with_skill", injection_text),
        ):
            variant_root = run_root / variant_name
            variant_root.mkdir(parents=True, exist_ok=True)
            for task in selected:
                print(f"[{variant_name}] {task.task_id}")
                result = execute_task(
                    task,
                    model_id=execution_model,
                    run_root=variant_root,
                    dataset_root=dataset_root,
                    service_code_root=service_code_root,
                    config_path=config_path,
                    local=True,
                    prompt_prefix=prompt_prefix,
                )
                grade = grade_execution_result(
                    task_yaml_path=task.task_yaml_path,
                    execution_result=result,
                    judge_model=judge_model,
                )
                result["grading"] = grade.to_dict()
                result_path = variant_root / task.task_id / "result.json"
                result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
                summary.append(
                    {
                        "variant": variant_name,
                        "task_id": task.task_id,
                        "task_score": grade.task_score,
                        "passed": grade.passed,
                        "scores": grade.scores,
                        "result_path": str(result_path),
                    }
                )
    finally:
        _cleanup()
        signal.signal(signal.SIGINT, previous_sigint)
        signal.signal(signal.SIGTERM, previous_sigterm)

    (run_root / "ab_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(run_root)


if __name__ == "__main__":
    main()
