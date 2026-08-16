#!/usr/bin/env python3

from __future__ import annotations

import argparse
import copy
import json
import os
import shutil
import subprocess
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from lib_agent import ensure_agent_exists, execute_openclaw_task, normalize_benchmark_model_id, slugify_model
from lib_grading import grade_task
from lib_tasks import TaskLoader

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="A/B evaluate Prompting skill injection with PinchBench graders")
    parser.add_argument(
        "--tasks-dir",
        default=str(Path(__file__).resolve().parents[1] / "tasks"),
    )
    parser.add_argument("--suite", required=True, help="Comma-separated task ids to run")
    parser.add_argument("--model", required=True)
    parser.add_argument("--judge", default="tokenpilot/gpt-5.4-mini")
    parser.add_argument("--skill-file", required=True, help="Path to distilled_skill.json")
    parser.add_argument("--next-objective", required=True, help="Objective text used in the injected skill block")
    parser.add_argument(
        "--output-dir",
        default=str(Path(__file__).resolve().parents[1] / "save" / "prompting_ab"),
    )
    parser.add_argument(
        "--provider-prefix",
        default=os.environ.get("BASELINE_PROVIDER_PREFIX", "kuaipao"),
        help="Provider prefix used to resolve bare model aliases, matching PinchBench baseline scripts.",
    )
    parser.add_argument(
        "--tmp-openclaw",
        action="store_true",
        help="Use a run-local copied OpenClaw home/config and patch it for baseline runtime.",
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


def resolve_model_alias(model_like: str, provider_prefix: str) -> str:
    text = (model_like or "").strip().replace("gpt-5-4-mini", "gpt-5.4-mini")
    if "/" in text:
        return text
    if not provider_prefix:
        raise ValueError(f"Model alias {model_like} requires provider_prefix")
    mapping = {
        "gpt-5.4-mini": f"{provider_prefix}/gpt-5.4-mini",
        "gpt-5-mini": f"{provider_prefix}/gpt-5-mini",
        "gpt-5": f"{provider_prefix}/gpt-5",
        "gpt-4.1-mini": f"{provider_prefix}/gpt-4.1-mini",
        "gpt-4.1": f"{provider_prefix}/gpt-4.1",
        "gpt-4o-mini": f"{provider_prefix}/gpt-4o-mini",
        "gpt-4o": f"{provider_prefix}/gpt-4o",
    }
    return mapping.get(text, f"{provider_prefix}/{text}")


def _is_truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def import_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if key and key not in os.environ:
            os.environ[key] = value


def import_runtime_envs() -> None:
    root = Path(__file__).resolve().parents[2]
    repo_root = Path(__file__).resolve().parents[5]
    import_dotenv(root / ".env")
    import_dotenv(repo_root / ".env")


def model_env_key(model_like: str) -> str:
    model_name = (model_like or "").strip().replace("gpt-5-4-mini", "gpt-5.4-mini")
    if "/" in model_name:
        model_name = model_name.split("/")[-1]
    return "".join(ch if ch.isalnum() else "_" for ch in model_name.upper())


def apply_model_runtime_env(model_like: str) -> None:
    model_key = model_env_key(model_like)
    base_var = f"PINCHBENCH_MODEL_{model_key}_BASE_URL"
    key_var = f"PINCHBENCH_MODEL_{model_key}_API_KEY"
    provider_var = f"PINCHBENCH_MODEL_{model_key}_PROVIDER_PREFIX"
    if os.environ.get(base_var):
        os.environ["TOKENPILOT_BASE_URL"] = os.environ[base_var]
    if os.environ.get(key_var):
        os.environ["TOKENPILOT_API_KEY"] = os.environ[key_var]
    if os.environ.get(provider_var):
        os.environ["PINCHBENCH_MODEL_PROVIDER_PREFIX"] = os.environ[provider_var]


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def patch_baseline_runtime_config(
    config_path: Path,
    resolved_model: str,
    resolved_judge: str,
    provider_prefix: str,
) -> None:
    cfg = load_json(config_path)
    baseline_base_url = str(os.environ.get("TOKENPILOT_BASE_URL", "")).strip()
    baseline_api_key = str(os.environ.get("TOKENPILOT_API_KEY", "")).strip()
    if not baseline_base_url or not baseline_api_key:
        raise RuntimeError("Missing TOKENPILOT_BASE_URL or TOKENPILOT_API_KEY for PinchBench baseline runtime patch")

    provider_name = resolved_model.split("/", 1)[0] if "/" in resolved_model else provider_prefix
    if not provider_name:
        raise RuntimeError("Unable to resolve baseline provider prefix")
    model_id = resolved_model.split("/")[-1]
    judge_id = resolved_judge.split("/")[-1]
    gateway_token = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "").strip() or f"pb-gateway-{int(time.time())}"

    plugins = cfg.setdefault("plugins", {})
    load_cfg = plugins.setdefault("load", {})
    entries = plugins.setdefault("entries", {})
    slots = plugins.setdefault("slots", {})
    tokenpilot = entries.setdefault("tokenpilot", {})
    tokenpilot["enabled"] = False
    slots["contextEngine"] = "legacy"
    tokenpilot_cfg = tokenpilot.setdefault("config", {})
    tokenpilot_cfg.setdefault("hooks", {})["beforeToolCall"] = False
    tokenpilot_cfg.setdefault("hooks", {})["toolResultPersist"] = False
    tokenpilot_cfg.setdefault("contextEngine", {})["enabled"] = False
    modules = tokenpilot_cfg.setdefault("modules", {})
    modules["stabilizer"] = False
    modules["policy"] = False
    modules["reduction"] = False
    modules["eviction"] = False
    reduction_cfg = tokenpilot_cfg.setdefault("reduction", {})
    passes = reduction_cfg.setdefault("passes", {})
    for key in list(passes.keys()):
        passes[key] = False
    for key in (
        "repeatedReadDedup",
        "toolPayloadTrim",
        "htmlSlimming",
        "execOutputTruncation",
        "agentsStartupOptimization",
        "memoryFaultRecovery",
    ):
        passes[key] = False
    tokenpilot_cfg.setdefault("eviction", {})["enabled"] = False
    tokenpilot_cfg.setdefault("taskStateEstimator", {})["enabled"] = False
    plugins["allow"] = ["tokenpilot"]
    load_cfg["paths"] = [str(Path.home() / ".openclaw" / "extensions" / "tokenpilot")]

    tools = cfg.setdefault("tools", {})
    exec_cfg = tools.setdefault("exec", {})
    exec_cfg["host"] = os.environ.get("TOKENPILOT_EXEC_HOST", "gateway")
    exec_cfg["security"] = os.environ.get("TOKENPILOT_EXEC_SECURITY", "full")
    exec_cfg["ask"] = os.environ.get("TOKENPILOT_EXEC_ASK", "off")
    tools["allow"] = ["memory_fault_recover"]
    tools["deny"] = []
    elevated_cfg = tools.setdefault("elevated", {})
    elevated_cfg["enabled"] = _is_truthy(os.environ.get("TOKENPILOT_ELEVATED_ENABLED", "true"))
    allow_from = elevated_cfg.setdefault("allowFrom", {})
    allow_from[os.environ.get("TOKENPILOT_ELEVATED_ALLOW_FROM", "webchat")] = ["exec"]

    models = cfg.setdefault("models", {})
    providers = models.setdefault("providers", {})
    provider = providers.setdefault(provider_name, {})
    provider["baseUrl"] = baseline_base_url
    provider["apiKey"] = baseline_api_key
    provider["api"] = "openai-completions"

    existing = {
        str(item.get("id") or ""): item
        for item in (provider.get("models") or [])
        if isinstance(item, dict)
    }
    for candidate in {model_id, judge_id}:
        if not candidate:
            continue
        existing[candidate] = {
            "id": candidate,
            "name": candidate,
            "api": "openai-completions",
            "reasoning": False,
            "input": ["text", "image"],
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
            "contextWindow": 500000,
            "maxTokens": 16384,
        }
    provider["models"] = list(existing.values())

    gateway = cfg.setdefault("gateway", {})
    gateway["mode"] = "local"
    auth_cfg = gateway.get("auth")
    if not isinstance(auth_cfg, dict):
        auth_cfg = {"mode": "token"}
    auth_cfg["mode"] = "token"
    auth_cfg["token"] = gateway_token
    gateway["auth"] = auth_cfg
    remote = gateway.get("remote")
    if isinstance(remote, dict):
        remote["token"] = gateway_token
    write_json(config_path, cfg)


def ensure_exec_approvals(approvals_path: Path) -> None:
    approvals_path.parent.mkdir(parents=True, exist_ok=True)
    allowlist = [
        {"id": "usr_bin_find", "pattern": "/usr/bin/find"},
        {"id": "usr_bin_ls", "pattern": "/usr/bin/ls"},
        {"id": "usr_bin_sort", "pattern": "/usr/bin/sort"},
        {"id": "usr_bin_grep", "pattern": "/usr/bin/grep"},
        {"id": "usr_bin_head", "pattern": "/usr/bin/head"},
        {"id": "usr_bin_tail", "pattern": "/usr/bin/tail"},
        {"id": "usr_bin_wc", "pattern": "/usr/bin/wc"},
        {"id": "usr_bin_cut", "pattern": "/usr/bin/cut"},
        {"id": "usr_bin_tr", "pattern": "/usr/bin/tr"},
        {"id": "usr_bin_uniq", "pattern": "/usr/bin/uniq"},
    ]
    data: dict[str, Any] = {}
    if approvals_path.exists():
        try:
            data = load_json(approvals_path)
        except Exception:
            data = {}
    data["version"] = 1
    socket_cfg = data.setdefault("socket", {})
    socket_cfg["path"] = str(approvals_path.with_suffix(".sock"))
    socket_cfg["token"] = socket_cfg.get("token") or f"pb-{int(time.time())}"
    agents = data.setdefault("agents", {})
    wildcard = agents.setdefault("*", {})
    wildcard["allowlist"] = allowlist
    write_json(approvals_path, data)


def ensure_gateway_running(env: dict[str, str]) -> None:
    subprocess.run(["openclaw", "config", "validate"], env=env, check=True, capture_output=True, text=True)
    config = load_json(Path(env["OPENCLAW_CONFIG_PATH"]))
    gateway_port = int(config.get("gateway", {}).get("port", 28789))
    log_path = Path("/tmp/openclaw_gateway.log")
    if not _is_truthy(env.get("PINCHBENCH_SKIP_GATEWAY_FORCE_RESTART", "false")):
        subprocess.run(
            ["pkill", "-f", f"openclaw gateway run --force --port {gateway_port}"],
            check=False,
            capture_output=True,
            text=True,
        )
    with log_path.open("w", encoding="utf-8") as log_fp:
        subprocess.Popen(
            ["openclaw", "gateway", "run", "--force", "--port", str(gateway_port)],
            env=env,
            stdout=log_fp,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    deadline = time.time() + 30
    last_error = ""
    while time.time() < deadline:
        result = subprocess.run(
            ["openclaw", "gateway", "health"],
            env=env,
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            return
        last_error = (result.stderr or result.stdout or "").strip()
        time.sleep(1)
    tail = ""
    if log_path.exists():
        try:
            tail = "\n".join(log_path.read_text(encoding="utf-8", errors="replace").splitlines()[-40:])
        except Exception:
            tail = ""
    raise RuntimeError(
        "OpenClaw gateway did not become healthy in time"
        + (f": {last_error}" if last_error else "")
        + (f"\nGateway log tail:\n{tail}" if tail else "")
    )


@contextmanager
def prepared_openclaw_env(run_root: Path, resolved_model: str, resolved_judge: str, provider_prefix: str, use_tmp: bool):
    old_env = {
        key: os.environ.get(key)
        for key in [
            "HOME",
            "OPENCLAW_CONFIG_PATH",
            "OPENCLAW_STATE_DIR",
            "XDG_CACHE_HOME",
            "XDG_CONFIG_HOME",
            "PINCHBENCH_OPENCLAW_CONFIG_PATH",
            "PINCHBENCH_OPENCLAW_STATE_DIR",
            "TOKENPILOT_OPENCLAW_HOME",
            "TOKENPILOT_EXEC_APPROVALS_PATH",
        ]
    }
    try:
        if use_tmp:
            src_home = Path(os.environ.get("TOKENPILOT_OPENCLAW_HOME") or str(Path.home())).resolve()
            src_state_dir = Path(
                os.environ.get("OPENCLAW_STATE_DIR")
                or os.environ.get("PINCHBENCH_OPENCLAW_STATE_DIR")
                or str(src_home / ".openclaw")
            ).resolve()
            src_config_path = Path(
                os.environ.get("OPENCLAW_CONFIG_PATH")
                or os.environ.get("PINCHBENCH_OPENCLAW_CONFIG_PATH")
                or str(src_state_dir / "openclaw.json")
            ).resolve()
            tmp_home = run_root / "openclaw_home"
            if tmp_home.exists():
                shutil.rmtree(tmp_home)
            tmp_home.mkdir(parents=True, exist_ok=True)
            tmp_state_dir = tmp_home / ".openclaw"
            shutil.copytree(src_state_dir, tmp_state_dir, dirs_exist_ok=True)
            config_path = tmp_home / ".openclaw" / "openclaw.json"
            state_dir = tmp_home / ".openclaw"
            if not config_path.exists() and src_config_path.exists():
                shutil.copy2(src_config_path, config_path)
            os.environ["HOME"] = str(tmp_home)
            os.environ["TOKENPILOT_OPENCLAW_HOME"] = str(tmp_home)
            os.environ["OPENCLAW_CONFIG_PATH"] = str(config_path)
            os.environ["OPENCLAW_STATE_DIR"] = str(state_dir)
            os.environ["PINCHBENCH_OPENCLAW_CONFIG_PATH"] = str(config_path)
            os.environ["PINCHBENCH_OPENCLAW_STATE_DIR"] = str(state_dir)
            os.environ["XDG_CACHE_HOME"] = str(tmp_home / ".cache")
            os.environ["XDG_CONFIG_HOME"] = str(tmp_home / ".config")
            os.environ["TOKENPILOT_EXEC_APPROVALS_PATH"] = str(state_dir / "exec-approvals.json")
            patch_baseline_runtime_config(config_path, resolved_model, resolved_judge, provider_prefix)
            ensure_exec_approvals(Path(os.environ["TOKENPILOT_EXEC_APPROVALS_PATH"]))
            ensure_gateway_running(os.environ.copy())
        yield
    finally:
        for key, value in old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def clone_task_with_prefixed_prompt(task: Any, prompt_prefix: str) -> Any:
    cloned = copy.deepcopy(task)
    cloned.prompt = f"{prompt_prefix}\n\n{task.prompt}".strip()
    return cloned


def main() -> None:
    args = parse_args()
    import_runtime_envs()
    apply_model_runtime_env(args.model)
    apply_model_runtime_env(args.judge)
    tasks_dir = Path(args.tasks_dir).resolve()
    output_root = Path(args.output_dir).resolve()
    output_root.mkdir(parents=True, exist_ok=True)

    loader = TaskLoader(tasks_dir)
    all_tasks = loader.load_all_tasks()
    wanted = [item.strip() for item in args.suite.split(",") if item.strip()]
    selected = [task for task in all_tasks if task.task_id in wanted]
    if not selected:
      raise SystemExit(f"No tasks matched suite={args.suite}")

    skill = json.loads(Path(args.skill_file).read_text(encoding="utf-8"))
    injection = build_injection_text(skill, args.next_objective)

    run_id = time.strftime("run_%Y%m%d_%H%M%S")
    run_root = output_root / run_id
    run_root.mkdir(parents=True, exist_ok=True)

    model_id = normalize_benchmark_model_id(resolve_model_alias(args.model, args.provider_prefix))
    judge_id = normalize_benchmark_model_id(resolve_model_alias(args.judge, args.provider_prefix))
    summary_rows: list[dict[str, Any]] = []

    with prepared_openclaw_env(run_root, model_id, judge_id, args.provider_prefix, args.tmp_openclaw):
        for task in selected:
            task_dir = run_root / task.task_id
            task_dir.mkdir(parents=True, exist_ok=True)

            baseline_agent = f"bench-{slugify_model(model_id)}-{task.task_id}-baseline"
            baseline_workspace = Path("/tmp/pinchbench") / run_id / f"{task.task_id}_baseline"
            ensure_agent_exists(baseline_agent, model_id, baseline_workspace)
            baseline_result = execute_openclaw_task(
                task=task,
                agent_id=baseline_agent,
                model_id=model_id,
                run_id=f"{run_id}-{task.task_id}-baseline",
                timeout_multiplier=1.0,
                skill_dir=tasks_dir,
                agent_workspace=baseline_workspace,
                verbose=False,
                session_mode="isolated",
                cleanup_sessions=True,
            )
            baseline_grade = grade_task(
                task=task,
                execution_result=baseline_result,
                skill_dir=tasks_dir,
                judge_model=judge_id,
            )
            baseline_result["grading"] = baseline_grade.to_dict()
            (task_dir / "baseline_result.json").write_text(
                json.dumps(baseline_result, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

            prompting_task = clone_task_with_prefixed_prompt(task, injection)
            prompting_agent = f"bench-{slugify_model(model_id)}-{task.task_id}-prompting"
            prompting_workspace = Path("/tmp/pinchbench") / run_id / f"{task.task_id}_prompting"
            ensure_agent_exists(prompting_agent, model_id, prompting_workspace)
            prompting_result = execute_openclaw_task(
                task=prompting_task,
                agent_id=prompting_agent,
                model_id=model_id,
                run_id=f"{run_id}-{task.task_id}-prompting",
                timeout_multiplier=1.0,
                skill_dir=tasks_dir,
                agent_workspace=prompting_workspace,
                verbose=False,
                session_mode="isolated",
                cleanup_sessions=True,
            )
            prompting_grade = grade_task(
                task=task,
                execution_result=prompting_result,
                skill_dir=tasks_dir,
                judge_model=judge_id,
            )
            prompting_result["grading"] = prompting_grade.to_dict()
            (task_dir / "prompting_result.json").write_text(
                json.dumps(prompting_result, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            (task_dir / "injected_prompt.txt").write_text(injection, encoding="utf-8")

            summary_rows.append(
                {
                    "task_id": task.task_id,
                    "baseline_score": baseline_grade.score,
                    "prompting_score": prompting_grade.score,
                    "delta": prompting_grade.score - baseline_grade.score,
                }
            )
            print(
                f"[task] {task.task_id} baseline={baseline_grade.score:.4f} "
                f"prompting={prompting_grade.score:.4f} "
                f"delta={prompting_grade.score - baseline_grade.score:+.4f}"
            )

    baseline_avg = sum(row["baseline_score"] for row in summary_rows) / len(summary_rows)
    prompting_avg = sum(row["prompting_score"] for row in summary_rows) / len(summary_rows)
    summary = {
        "suite": wanted,
        "baseline_avg": baseline_avg,
        "prompting_avg": prompting_avg,
        "delta_avg": prompting_avg - baseline_avg,
        "rows": summary_rows,
        "model": model_id,
        "judge": judge_id,
    }
    (run_root / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(run_root)


if __name__ == "__main__":
    main()
