#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import socket
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib import request as urllib_request

from benchmark import (
    _apply_tokenpilot_runtime_settings,
    _available_provider_models,
    _default_service_code_root,
    _resolve_model_id,
    _synchronize_run_tool_allowlist,
)
from eval_prompt_ab import build_injection_text
from lib_agent import execute_task
from lib_grading import grade_execution_result
from lib_services import (
    activate_plugins_for_run,
    build_plugin_install_plan,
    cleanup_claw_eval_plugin_state,
    restore_plugins_after_run,
    summarize_plugin_closure,
)
from lib_tasks import ClawEvalTask, ClawEvalTaskLoader


def parse_args() -> argparse.Namespace:
    default_openclaw_home = (
        os.environ.get("TOKENPILOT_OPENCLAW_HOME")
        or str(Path.home())
    )
    parser = argparse.ArgumentParser(description="Category-level Prompting evaluation with cumulative skill injection")
    parser.add_argument("--tasks-dir", default=str(Path(__file__).resolve().parents[1] / "dataset" / "tasks"))
    parser.add_argument("--trace-root", default=str(Path(__file__).resolve().parents[1] / "traces"))
    parser.add_argument("--category", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--judge", default="kuaipao/gpt-5.4-mini")
    default_prompt_root = Path(__file__).resolve().parents[3] / "test_prompt"
    parser.add_argument("--prompt-harness", default=str(default_prompt_root / "prompt_harness.mjs"))
    parser.add_argument("--prompt-runs-root", default=str(default_prompt_root / "runs"))
    parser.add_argument("--output-dir", default=str(Path(__file__).resolve().parents[1] / "save" / "prompting_category"))
    parser.add_argument(
        "--plugin-root",
        default=str(Path(__file__).resolve().parents[1] / "plugins"),
    )
    parser.add_argument(
        "--source-openclaw-home",
        default=os.environ.get("SOURCE_OPENCLAW_HOME", str(Path.home())),
    )
    parser.add_argument(
        "--openclaw-config-path",
        default=os.environ.get(
            "OPENCLAW_CONFIG_PATH",
            str(Path(default_openclaw_home) / ".openclaw" / "openclaw.json"),
        ),
    )
    parser.add_argument("--max-tasks", type=int, default=0)
    return parser.parse_args()


def run_shell(command: str) -> None:
    subprocess.run(command, shell=True, check=True)


def pick_ephemeral_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def prepare_tmp_openclaw_home(source_home: Path, label: str) -> tuple[Path, Path, int]:
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
    raw = json.loads(config_path.read_text(encoding="utf-8"))
    gateway_port = pick_ephemeral_port()
    proxy_port = pick_ephemeral_port()
    raw.setdefault("gateway", {})["port"] = gateway_port
    plugins = raw.setdefault("plugins", {})
    load = plugins.get("load")
    if isinstance(load, dict) and isinstance(load.get("paths"), list):
        load["paths"] = [path for path in load["paths"] if Path(str(path)).exists()]
    entries = plugins.setdefault("entries", {})
    tokenpilot = entries.setdefault("tokenpilot", {})
    tokenpilot_cfg = tokenpilot.setdefault("config", {})
    tokenpilot_cfg["proxyPort"] = proxy_port
    config_path.write_text(json.dumps(raw, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    os.environ["TOKENPILOT_OPENCLAW_HOME"] = str(tmp_home)
    os.environ["OPENCLAW_CONFIG_PATH"] = str(config_path)
    os.environ["HOME"] = str(tmp_home)
    os.environ["XDG_CONFIG_HOME"] = str(tmp_home / ".config")
    os.environ["XDG_CACHE_HOME"] = str(tmp_home / ".cache")
    os.environ["UV_CACHE_DIR"] = "/tmp/uv-cache"
    os.environ["TOKENPILOT_GATEWAY_PORT"] = str(gateway_port)
    Path(os.environ["XDG_CONFIG_HOME"]).mkdir(parents=True, exist_ok=True)
    Path(os.environ["XDG_CACHE_HOME"]).mkdir(parents=True, exist_ok=True)
    Path(os.environ["UV_CACHE_DIR"]).mkdir(parents=True, exist_ok=True)
    return tmp_home, config_path, gateway_port


def start_tmp_gateway(gateway_port: int) -> subprocess.Popen[str]:
    proc = subprocess.Popen(
        ["openclaw", "gateway", "run", "--force", "--port", str(gateway_port)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=os.environ.copy(),
    )
    for _ in range(30):
        try:
            with socket.create_connection(("127.0.0.1", gateway_port), timeout=0.5):
                return proc
        except OSError:
            pass
        if proc.poll() is not None:
            output = proc.stdout.read() if proc.stdout else ""
            raise SystemExit(f"Failed to start OpenClaw gateway\n{output}")
        import time

        time.sleep(1)
    proc.terminate()
    output = proc.stdout.read() if proc.stdout else ""
    raise SystemExit(f"Timed out waiting for OpenClaw gateway\n{output}")


def find_trace_map(trace_root: Path) -> dict[str, Path]:
    trace_map: dict[str, Path] = {}
    pattern = re.compile(r"(T\d+[A-Za-z0-9_]*?)_[0-9a-f]{8}\.jsonl$")
    for path in trace_root.rglob("*.jsonl"):
        match = pattern.match(path.name)
        if not match:
            continue
        task_id = match.group(1)
        trace_map.setdefault(task_id, path)
    return trace_map


def objective_hint_for_task(task: ClawEvalTask) -> str:
    prompt = " ".join(task.prompt.split())
    return prompt[:300]


def distill_skill_from_trace(
    *,
    harness_path: Path,
    trace_path: Path,
    out_dir: Path,
    next_objective: str,
    env: dict[str, str],
) -> dict[str, Any]:
    out_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "node",
            str(harness_path),
            "--source",
            str(trace_path),
            "--out-dir",
            str(out_dir),
            "--next-objective",
            next_objective,
        ],
        check=True,
        env=env,
    )
    return json.loads((out_dir / "distilled_skill.json").read_text(encoding="utf-8"))


def build_query_text(task: ClawEvalTask) -> str:
    parts = [task.task_name, task.category, task.prompt]
    return " ".join(part.strip() for part in parts if part and part.strip()).lower()


def tokenize(text: str) -> set[str]:
    return {term for term in re.findall(r"[a-z0-9_]+", text.lower()) if len(term) > 2}


def lexical_score(skill: dict[str, Any], query: str) -> tuple[int, int]:
    objective = str(skill.get("objective") or "").lower()
    workflow = " ".join(str(x) for x in (skill.get("workflow") or [] if isinstance(skill.get("workflow"), list) else []))
    tool_patterns = " ".join(str(x) for x in (skill.get("tool_patterns") or [] if isinstance(skill.get("tool_patterns"), list) else []))
    text = f"{objective} {workflow} {tool_patterns}".lower()
    query_terms = tokenize(query)
    objective_terms = tokenize(objective)
    text_terms = tokenize(text)
    overlap = query_terms & text_terms
    objective_overlap = query_terms & objective_terms
    return len(overlap), len(objective_overlap)


def select_top1_skill(skills: list[dict[str, Any]], task: ClawEvalTask) -> dict[str, Any] | None:
    if not skills:
        return None
    query = build_query_text(task)
    ranked = sorted(
        skills,
        key=lambda skill: (lexical_score(skill, query)[1], lexical_score(skill, query)[0], -skills.index(skill)),
        reverse=True,
    )
    best = ranked[0]
    overlap, objective_overlap = lexical_score(best, query)
    if objective_overlap >= 2:
        return best
    if objective_overlap >= 1 and overlap >= 3:
        return best
    return None


def normalize_base_url(base_url: str) -> str:
    return base_url.rstrip("/")


def extract_text_from_chat_payload(payload: dict[str, Any]) -> str:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    content = ((choices[0] or {}).get("message") or {}).get("content")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        texts = []
        for part in content:
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                texts.append(part["text"].strip())
        return "\n".join(text for text in texts if text)
    return ""


def llm_skill_relevant(skill: dict[str, Any], task: ClawEvalTask) -> bool:
    api_key = (
        os.environ.get("TOKENPILOT_MEMORY_DISTILL_API_KEY")
        or os.environ.get("TOKENPILOT_TASK_STATE_ESTIMATOR_API_KEY")
        or ""
    ).strip()
    base_url = (
        os.environ.get("TOKENPILOT_MEMORY_DISTILL_BASE_URL")
        or os.environ.get("TOKENPILOT_TASK_STATE_ESTIMATOR_BASE_URL")
        or ""
    ).strip()
    model = (
        os.environ.get("TOKENPILOT_MEMORY_DISTILL_MODEL")
        or os.environ.get("TOKENPILOT_TASK_STATE_ESTIMATOR_MODEL")
        or ""
    ).strip()
    if not api_key or not base_url or not model:
        return True

    system_prompt = (
        "You are a binary relevance filter for procedural memory injection. "
        "Given a current task objective and one candidate skill, decide whether injecting this skill is likely to help the current task. "
        "Be conservative: if the skill is only loosely related, output no. "
        "Reply with JSON only: {\"relevant\":\"yes\"} or {\"relevant\":\"no\"}."
    )
    user_prompt = json.dumps(
        {
            "task_id": task.task_id,
            "task_name": task.task_name,
            "category": task.category,
            "task_objective": objective_hint_for_task(task),
            "skill": {
                "objective": skill.get("objective"),
                "workflow": skill.get("workflow"),
                "tool_patterns": skill.get("tool_patterns"),
                "pitfalls": skill.get("pitfalls"),
            },
        },
        ensure_ascii=False,
    )
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0,
    }
    req = urllib_request.Request(
        f"{normalize_base_url(base_url)}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    try:
        with urllib_request.urlopen(req, timeout=30) as resp:
            raw = json.loads(resp.read().decode("utf-8"))
        text = extract_text_from_chat_payload(raw)
        parsed = json.loads(text)
        return str(parsed.get("relevant") or "").strip().lower() == "yes"
    except Exception:
        return True


def main() -> None:
    args = parse_args()
    tasks_dir = Path(args.tasks_dir).resolve()
    trace_root = Path(args.trace_root).resolve()
    harness_path = Path(args.prompt_harness).resolve()
    prompt_runs_root = Path(args.prompt_runs_root).resolve()
    output_root = Path(args.output_dir).resolve()
    source_home = Path(args.source_openclaw_home).expanduser().resolve()
    plugin_root = Path(args.plugin_root).resolve()

    loader = ClawEvalTaskLoader(tasks_dir)
    all_tasks = loader.load_all_tasks()
    category_tasks = [task for task in all_tasks if task.category == args.category]
    if args.max_tasks > 0:
        category_tasks = category_tasks[: args.max_tasks]
    if not category_tasks:
        raise SystemExit(f"No tasks found for category={args.category}")

    trace_map = find_trace_map(trace_root)
    selected = [task for task in category_tasks if task.task_id in trace_map]
    if not selected:
        raise SystemExit(f"No traces found for category={args.category}")
    for task in selected:
        task.frontmatter["_dataset_root"] = str(tasks_dir.parent.resolve())

    tmp_home, config_path, gateway_port = prepare_tmp_openclaw_home(source_home, f"prompting-{args.category}")
    run_id = datetime.now(timezone.utc).strftime("run_%Y%m%d_%H%M%S")
    run_root = output_root / run_id
    run_root.mkdir(parents=True, exist_ok=True)

    execution_model = _resolve_model_id(args.model, config_path, purpose="execution")
    judge_model = _resolve_model_id(args.judge, config_path, purpose="judge")
    if execution_model not in _available_provider_models(config_path):
        print(f"[warn] model {execution_model} not found in providers; relying on runtime/provider fallback")

    all_declared_tools = sorted({tool for task in all_tasks for tool in task.declared_tools if tool})
    closure = summarize_plugin_closure(selected)
    install_plan = build_plugin_install_plan(selected, plugin_root)
    if install_plan.missing_plugin_ids:
        raise SystemExit(f"Missing plugin manifests for: {', '.join(install_plan.missing_plugin_ids)}")

    summary_rows: list[dict[str, Any]] = []
    accumulated_skills: list[dict[str, Any]] = []
    gateway_proc = None
    activation_plan = None
    cleaned = False

    def _cleanup() -> None:
        nonlocal cleaned
        if cleaned:
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
            cleaned = True

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
        gateway_proc = start_tmp_gateway(gateway_port)

        for task in selected:
            task_dir = run_root / task.task_id
            task_dir.mkdir(parents=True, exist_ok=True)
            baseline_result = execute_task(
                task,
                model_id=execution_model,
                run_root=task_dir / "baseline",
                dataset_root=tasks_dir.parent,
                service_code_root=_default_service_code_root(),
                config_path=config_path,
                local=True,
            )
            baseline_grade = grade_execution_result(
                task_yaml_path=task.task_yaml_path,
                execution_result=baseline_result,
                judge_model=judge_model,
            )
            baseline_result["grading"] = baseline_grade.to_dict()
            (task_dir / "baseline_result.json").write_text(
                json.dumps(baseline_result, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

            selected_skill = select_top1_skill(accumulated_skills, task)
            if selected_skill is not None and not llm_skill_relevant(selected_skill, task):
                selected_skill = None
            prompt_prefix = (
                build_injection_text(selected_skill, objective_hint_for_task(task))
                if selected_skill is not None
                else None
            )
            prompting_result = execute_task(
                task,
                model_id=execution_model,
                run_root=task_dir / "prompting",
                dataset_root=tasks_dir.parent,
                service_code_root=_default_service_code_root(),
                config_path=config_path,
                local=True,
                prompt_prefix=prompt_prefix,
            )
            prompting_grade = grade_execution_result(
                task_yaml_path=task.task_yaml_path,
                execution_result=prompting_result,
                judge_model=judge_model,
            )
            prompting_result["grading"] = prompting_grade.to_dict()
            (task_dir / "prompting_result.json").write_text(
                json.dumps(prompting_result, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

            trace_path = trace_map[task.task_id]
            skill = distill_skill_from_trace(
                harness_path=harness_path,
                trace_path=trace_path,
                out_dir=prompt_runs_root / f"{task.task_id}_category_prompting",
                next_objective=objective_hint_for_task(task),
                env=os.environ.copy(),
            )
            accumulated_skills.append(skill)
            (task_dir / "selected_skill.json").write_text(
                json.dumps(selected_skill, ensure_ascii=False, indent=2) if selected_skill is not None else "null\n",
                encoding="utf-8",
            )
            (task_dir / "new_skill.json").write_text(json.dumps(skill, ensure_ascii=False, indent=2), encoding="utf-8")

            summary_rows.append(
                {
                    "task_id": task.task_id,
                    "baseline_score": baseline_grade.task_score,
                    "prompting_score": prompting_grade.task_score,
                    "delta": prompting_grade.task_score - baseline_grade.task_score,
                    "used_prior_skill": selected_skill is not None,
                    "skill_count_before": max(0, len(accumulated_skills) - 1),
                }
            )
            print(
                f"[task] {task.task_id} baseline={baseline_grade.task_score:.4f} "
                f"prompting={prompting_grade.task_score:.4f} delta={prompting_grade.task_score - baseline_grade.task_score:+.4f}"
            )
    finally:
        _cleanup()
        signal.signal(signal.SIGINT, previous_sigint)
        signal.signal(signal.SIGTERM, previous_sigterm)

    avg_baseline = sum(row["baseline_score"] for row in summary_rows) / len(summary_rows)
    avg_prompting = sum(row["prompting_score"] for row in summary_rows) / len(summary_rows)
    summary = {
        "category": args.category,
        "task_count": len(summary_rows),
        "baseline_avg": avg_baseline,
        "prompting_avg": avg_prompting,
        "delta_avg": avg_prompting - avg_baseline,
        "rows": summary_rows,
        "required_plugins": closure["required_plugins"],
        "execution_model": execution_model,
        "judge_model": judge_model,
        "tmp_openclaw_home": str(tmp_home),
        "openclaw_config_path": str(config_path),
    }
    (run_root / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(run_root)


if __name__ == "__main__":
    main()
