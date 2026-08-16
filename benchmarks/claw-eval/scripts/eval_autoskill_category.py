#!/usr/bin/env python3
"""
Category-level AutoSkill evaluation.

This script evaluates AutoSkill in a way that is closer to the original
repository behavior:
1. Run each task without injected skills and grade it.
2. Retrieve the most relevant prior skill from an AutoSkill SDK store and,
   if relevant, inject the rendered skill context into the next run.
3. Grade the skill-augmented run.
4. Ingest the baseline transcript into AutoSkill via sdk.ingest(...) so later
   tasks can retrieve the accumulated skills.

Compared with the earlier distill_core-only version, this uses the full SDK
pipeline: ingest -> maintain -> search/render_context.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import time
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parents[0]
sys.path.insert(0, str(SCRIPTS_DIR))

AUTOSKILL_ROOT = Path(__file__).resolve().parents[4] / "AutoSkill"
if AUTOSKILL_ROOT.exists():
    sys.path.insert(0, str(AUTOSKILL_ROOT))

from autoskill import AutoSkill, AutoSkillConfig
from autoskill.offline.trajectory.extract import extract_from_agentic_trajectory
from autoskill.offline.provider_config import build_embeddings_config, build_llm_config

from benchmark import (
    _apply_tokenpilot_runtime_settings,
    _available_provider_models,
    _default_service_code_root,
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
from lib_tasks import ClawEvalTask, ClawEvalTaskLoader


def parse_args() -> argparse.Namespace:
    default_openclaw_home = (
        os.environ.get("TOKENPILOT_OPENCLAW_HOME")
        or str(Path.home())
    )
    parser = argparse.ArgumentParser(
        description="Category-level AutoSkill evaluation with cumulative skill injection"
    )
    parser.add_argument(
        "--tasks-dir",
        default=str(Path(__file__).resolve().parents[1] / "dataset" / "tasks"),
    )
    parser.add_argument("--category", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--judge", default="kuaipao/gpt-5.4-mini")
    parser.add_argument(
        "--llm-provider",
        default="generic",
        choices=["generic", "openai", "dashscope", "glm", "internlm", "anthropic", "mock"],
        help="AutoSkill LLM provider for skill extraction/maintenance",
    )
    parser.add_argument(
        "--embeddings-provider",
        default="",
        help="AutoSkill embeddings provider (default: inferred from llm-provider)",
    )
    parser.add_argument(
        "--distill-model",
        default=None,
        help="Model used by AutoSkill extraction/maintenance (default: same as --model)",
    )
    parser.add_argument(
        "--embedding-model",
        default=None,
        help="Embedding model used by AutoSkill retrieval",
    )
    parser.add_argument(
        "--output-dir",
        default=str(Path(__file__).resolve().parents[1] / "save" / "autoskill_category"),
    )
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
    parser.add_argument("--top-k", type=int, default=1)
    parser.add_argument(
        "--max-context-chars",
        type=int,
        default=3000,
        help="Max chars for rendered AutoSkill context",
    )
    parser.add_argument(
        "--min-search-score",
        type=float,
        default=0.2,
        help="Minimum retrieval score required before injecting a skill",
    )
    return parser.parse_args()


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
        time.sleep(1)
    proc.terminate()
    output = proc.stdout.read() if proc.stdout else ""
    raise SystemExit(f"Timed out waiting for OpenClaw gateway\n{output}")


def load_transcript_from_session_file(session_file: str | Path | None) -> list[dict[str, Any]]:
    if not session_file:
        return []
    path = Path(session_file) if not isinstance(session_file, Path) else session_file
    if not path.exists():
        return []
    entries: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return entries


def format_transcript_for_autoskill(transcript: list[dict[str, Any]]) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = []
    for entry in transcript:
        if entry.get("type") != "message":
            continue
        msg = entry.get("message") or {}
        role = str(msg.get("role", "")).strip().lower()
        content = msg.get("content") or ""
        if isinstance(content, list):
            text_parts: list[str] = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    text_parts.append(str(block.get("text", "")))
            content = "\n".join(part for part in text_parts if part.strip())
        if role in ("user", "assistant", "system") and str(content).strip():
            messages.append({"role": role, "content": str(content).strip()})
    return messages


def build_trajectory_record(task: ClawEvalTask, messages: list[dict[str, str]]) -> dict[str, Any]:
    return {
        "success": True,
        "task": task.task_name,
        "goal": objective_hint_for_task(task),
        "messages": messages,
    }


def objective_hint_for_task(task: ClawEvalTask) -> str:
    prompt = " ".join(task.prompt.split())
    return prompt[:500]


def build_autoskill_sdk(
    *,
    args: argparse.Namespace,
    run_root: Path,
    user_id: str,
) -> AutoSkill:
    store_dir = run_root / "autoskill_store"
    llm_cfg = build_llm_config(args.llm_provider, model=args.distill_model or args.model)
    emb_cfg = build_embeddings_config(
        args.embeddings_provider,
        model=args.embedding_model,
        llm_provider=str(llm_cfg.get("provider") or ""),
    )
    sdk_cfg = AutoSkillConfig(
        llm=llm_cfg,
        embeddings=emb_cfg,
        store={"provider": "local", "path": str(store_dir)},
        max_candidates_per_ingest=1,
        default_search_limit=max(1, int(args.top_k)),
        max_context_chars=max(500, int(args.max_context_chars)),
        redact_sources_before_llm=True,
        namespace=f"claw-eval-{args.category}",
    )
    sdk = AutoSkill(sdk_cfg)
    sdk.list(user_id=user_id)
    return sdk


def select_autoskill_context(
    *,
    sdk: AutoSkill,
    task: ClawEvalTask,
    user_id: str,
    top_k: int,
    min_search_score: float,
) -> tuple[str | None, dict[str, Any] | None]:
    query = " ".join(
        part.strip()
        for part in (task.task_name, task.category, objective_hint_for_task(task))
        if part and part.strip()
    )
    hits = sdk.search(query, user_id=user_id, limit=max(1, top_k), scope="user")
    if not hits:
        return None, None
    best = hits[0]
    if float(best.score) < float(min_search_score):
        return None, None
    rendered = sdk.render_context(query, user_id=user_id, limit=max(1, top_k), scope="user")
    if not rendered.strip():
        return None, None
    selected = {
        "id": best.skill.id,
        "name": best.skill.name,
        "description": best.skill.description,
        "score": best.score,
        "version": best.skill.version,
        "triggers": list(best.skill.triggers or []),
        "tags": list(best.skill.tags or []),
    }
    return rendered, selected


def main() -> None:
    args = parse_args()
    tasks_dir = Path(args.tasks_dir).resolve()
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

    tmp_home, config_path, gateway_port = prepare_tmp_openclaw_home(source_home, f"autoskill-{args.category}")
    run_id = datetime.now(timezone.utc).strftime("run_%Y%m%d_%H%M%S")
    run_root = output_root / run_id
    run_root.mkdir(parents=True, exist_ok=True)

    execution_model = _resolve_model_id(args.model, config_path, purpose="execution")
    judge_model = _resolve_model_id(args.judge, config_path, purpose="judge")
    if execution_model not in _available_provider_models(config_path):
        print(f"[warn] model {execution_model} not found in providers; relying on runtime/provider fallback")

    autoskill_user_id = f"{args.category}-session"
    sdk = build_autoskill_sdk(args=args, run_root=run_root, user_id=autoskill_user_id)
    print(
        f"[autoskill] llm_provider={args.llm_provider} "
        f"distill_model={args.distill_model or args.model} "
        f"embeddings_provider={args.embeddings_provider or 'auto'}"
    )

    all_declared_tools = sorted({tool for task in all_tasks for tool in task.declared_tools if tool})
    closure = summarize_plugin_closure(category_tasks)
    install_plan = build_plugin_install_plan(category_tasks, plugin_root)
    if install_plan.missing_plugin_ids:
        raise SystemExit(f"Missing plugin manifests for: {', '.join(install_plan.missing_plugin_ids)}")

    summary_rows: list[dict[str, Any]] = []
    gateway_proc = None
    activation_plan = None
    cleaned = False

    def run_shell(command: str) -> None:
        subprocess.run(command, shell=True, check=True)

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
        synchronized_tools = _synchronize_run_tool_allowlist(config_path, category_tasks, all_declared_tools)
        runtime_patch = _apply_tokenpilot_runtime_settings(config_path, execution_model=execution_model)
        if synchronized_tools:
            print(f"[tools] allowlist={synchronized_tools}")
        if runtime_patch:
            print(f"[tokenpilot] runtime patch={runtime_patch}")
        gateway_proc = start_tmp_gateway(gateway_port)

        for task in category_tasks:
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

            prompt_prefix, selected_skill = select_autoskill_context(
                sdk=sdk,
                task=task,
                user_id=autoskill_user_id,
                top_k=args.top_k,
                min_search_score=args.min_search_score,
            )

            autoskill_result = execute_task(
                task,
                model_id=execution_model,
                run_root=task_dir / "autoskill",
                dataset_root=tasks_dir.parent,
                service_code_root=_default_service_code_root(),
                config_path=config_path,
                local=True,
                prompt_prefix=prompt_prefix,
            )
            autoskill_grade = grade_execution_result(
                task_yaml_path=task.task_yaml_path,
                execution_result=autoskill_result,
                judge_model=judge_model,
            )
            autoskill_result["grading"] = autoskill_grade.to_dict()
            (task_dir / "autoskill_result.json").write_text(
                json.dumps(autoskill_result, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

            session_file = baseline_result.get("session_file")
            baseline_messages = format_transcript_for_autoskill(
                load_transcript_from_session_file(session_file)
            )
            ingested_skills = []
            ingest_error = None
            if baseline_messages:
                try:
                    extract_result = extract_from_agentic_trajectory(
                        sdk=sdk,
                        user_id=autoskill_user_id,
                        data={"records": [build_trajectory_record(task, baseline_messages)]},
                        metadata={
                            "task_id": task.task_id,
                            "category": task.category,
                            "channel": "claw_eval_category",
                        },
                        hint=f"Extract one reusable skill for {task.category} follow-up tasks.",
                        continue_on_error=False,
                        include_tool_events=False,
                        success_only=False,
                    )
                    ingested_skills = extract_result.get("skills") or []
                except Exception as exc:
                    ingest_error = str(exc)

            (task_dir / "selected_skill.json").write_text(
                json.dumps(selected_skill, ensure_ascii=False, indent=2) if selected_skill is not None else "null\n",
                encoding="utf-8",
            )
            (task_dir / "injected_context.txt").write_text(
                prompt_prefix or "",
                encoding="utf-8",
            )
            (task_dir / "new_skills.json").write_text(
                json.dumps(ingested_skills, ensure_ascii=False, indent=2)
                if ingested_skills
                else "[]\n",
                encoding="utf-8",
            )
            if ingest_error:
                (task_dir / "ingest_error.txt").write_text(ingest_error + "\n", encoding="utf-8")

            skill_count_after = len(sdk.list(user_id=autoskill_user_id))
            summary_rows.append(
                {
                    "task_id": task.task_id,
                    "baseline_score": baseline_grade.task_score,
                    "autoskill_score": autoskill_grade.task_score,
                    "delta": autoskill_grade.task_score - baseline_grade.task_score,
                    "used_prior_skill": selected_skill is not None,
                    "selected_skill_score": selected_skill.get("score") if selected_skill else None,
                    "skill_count_after": skill_count_after,
                    "ingested_new_skill_count": len(ingested_skills),
                    "ingest_error": ingest_error,
                }
            )
            print(
                f"[task] {task.task_id} baseline={baseline_grade.task_score:.4f} "
                f"autoskill={autoskill_grade.task_score:.4f} "
                f"delta={autoskill_grade.task_score - baseline_grade.task_score:+.4f} "
                f"(prior={'yes' if selected_skill else 'no'}, new={len(ingested_skills)})"
            )
    finally:
        _cleanup()
        signal.signal(signal.SIGINT, previous_sigint)
        signal.signal(signal.SIGTERM, previous_sigterm)

    avg_baseline = sum(row["baseline_score"] for row in summary_rows) / len(summary_rows)
    avg_autoskill = sum(row["autoskill_score"] for row in summary_rows) / len(summary_rows)
    summary = {
        "category": args.category,
        "task_count": len(summary_rows),
        "baseline_avg": avg_baseline,
        "autoskill_avg": avg_autoskill,
        "delta_avg": avg_autoskill - avg_baseline,
        "rows": summary_rows,
        "required_plugins": closure["required_plugins"],
        "execution_model": execution_model,
        "judge_model": judge_model,
        "llm_provider": args.llm_provider,
        "distill_model": args.distill_model or args.model,
        "embeddings_provider": args.embeddings_provider or "auto",
        "embedding_model": args.embedding_model,
        "top_k": args.top_k,
        "min_search_score": args.min_search_score,
        "tmp_openclaw_home": str(tmp_home),
    }
    (run_root / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(
        f"[summary] category={args.category} baseline_avg={avg_baseline:.4f} "
        f"autoskill_avg={avg_autoskill:.4f} delta={avg_autoskill - avg_baseline:+.4f}"
    )
    print(run_root)


if __name__ == "__main__":
    main()
