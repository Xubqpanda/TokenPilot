#!/usr/bin/env python3
"""
Evaluate an existing PinchBench raw result JSON without re-running generation.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv

ENV_FILE = Path(__file__).parent.parent.parent.parent.parent / ".env"
if ENV_FILE.exists():
    load_dotenv(ENV_FILE)

from benchmark import _compute_efficiency_summary, _grade_execution_result, _make_json_safe
from lib_tasks import TaskLoader


logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("evaluate_raw")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Evaluate existing PinchBench raw results")
    parser.add_argument("--input", required=True, help="Path to existing raw result JSON")
    parser.add_argument("--output", default=None, help="Path to write evaluated JSON")
    parser.add_argument("--judge", default=None, help="Judge model identifier")
    parser.add_argument(
        "--tasks-dir",
        default=None,
        help="Path to pinchbench tasks directory (defaults to sibling tasks/ directory)",
    )
    parser.add_argument("--verbose", "-v", action="store_true")
    parser.add_argument(
        "--max-llm-calls-per-task",
        type=int,
        default=int(os.environ.get("PINCHBENCH_MAX_LLM_CALLS_PER_TASK", "60")),
    )
    parser.add_argument(
        "--max-tool-calls-per-task",
        type=int,
        default=int(os.environ.get("PINCHBENCH_MAX_TOOL_CALLS_PER_TASK", "120")),
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    input_path = Path(args.input)
    if not input_path.exists():
        raise FileNotFoundError(f"Input raw JSON not found: {input_path}")

    output_path = Path(args.output) if args.output else input_path
    tasks_dir = (
        Path(args.tasks_dir)
        if args.tasks_dir
        else Path(__file__).resolve().parent.parent / "tasks"
    )
    task_loader = TaskLoader(tasks_dir)
    tasks_by_id = {task.task_id: task for task in task_loader.load_all_tasks()}

    judge_model = (
        args.judge
        or os.environ.get("TOKENPILOT_JUDGE")
        or "openrouter/anthropic/claude-opus-4.5"
    )

    aggregate = json.loads(input_path.read_text(encoding="utf-8"))
    task_entries: List[Dict[str, Any]] = list(aggregate.get("tasks", []))
    run_id = str(aggregate.get("run_id", "eval"))
    skill_dir = Path(__file__).resolve().parent.parent

    grades_by_task_id: Dict[str, Dict[str, Any]] = {}
    grades_runs_by_task: Dict[str, List[Any]] = {}

    for idx, entry in enumerate(task_entries):
        task_id = str(entry.get("task_id", ""))
        task = tasks_by_id.get(task_id)
        if task is None:
            logger.warning("Skipping unknown task id in raw file: %s", task_id)
            continue

        logger.info(
            "Evaluating task %s (%s/%s) with judge=%s",
            task_id,
            idx + 1,
            len(task_entries),
            judge_model,
        )
        started_at = time.time()

        execution_result = {
            "agent_id": entry.get("agent_id", ""),
            "task_id": task_id,
            "status": entry.get("status", "error"),
            "timed_out": entry.get("timed_out", False),
            "execution_time": entry.get("execution_time", 0.0),
            "transcript": entry.get("transcript", []),
            "llm_calls": entry.get("llm_calls", []),
            "llm_models": entry.get("llm_models", []),
            "usage": entry.get("usage", {}),
            "workspace": entry.get("workspace", ""),
            "stdout": entry.get("stdout", ""),
            "stderr": entry.get("stderr", ""),
            "exit_code": entry.get("exit_code", 0),
        }

        judge_agent_prefix = f"bench-judge-{run_id}-eval-j{idx:04d}"
        grade, call_counts = _grade_execution_result(
            task=task,
            execution_result=execution_result,
            skill_dir=skill_dir,
            verbose=args.verbose,
            judge_model=judge_model,
            judge_agent_prefix=judge_agent_prefix,
            max_llm_calls_per_task=args.max_llm_calls_per_task,
            max_tool_calls_per_task=args.max_tool_calls_per_task,
        )

        entry["status"] = execution_result.get("status", entry.get("status"))
        entry["stderr"] = execution_result.get("stderr", entry.get("stderr", ""))
        entry["usage"] = execution_result.get("usage", entry.get("usage", {}))
        entry["llm_calls"] = execution_result.get("llm_calls", entry.get("llm_calls", []))
        entry["llm_models"] = execution_result.get("llm_models", entry.get("llm_models", []))
        entry["call_counts"] = call_counts

        logger.info(
            "Finished task %s (%s/%s): score=%.3f elapsed=%.1fs",
            task_id,
            idx + 1,
            len(task_entries),
            grade.score,
            time.time() - started_at,
        )

        grades_runs_by_task.setdefault(task_id, []).append(grade)

    for task_id, grade_runs in grades_runs_by_task.items():
        scores = [grade.score for grade in grade_runs]
        mean = sum(scores) / len(scores) if scores else 0.0
        if len(scores) > 1:
            variance = sum((s - mean) ** 2 for s in scores) / (len(scores) - 1)
            std = variance ** 0.5
        else:
            std = 0.0
        grades_by_task_id[task_id] = {
            "runs": [grade.to_dict() for grade in grade_runs],
            "mean": mean,
            "std": std,
            "min": min(scores) if scores else 0.0,
            "max": max(scores) if scores else 0.0,
        }

    for entry in task_entries:
        task_id = str(entry.get("task_id", ""))
        entry["grading"] = grades_by_task_id.get(
            task_id,
            {"runs": [], "mean": 0.0, "std": 0.0, "min": 0.0, "max": 0.0},
        )

    aggregate["tasks"] = task_entries
    aggregate["efficiency"] = _compute_efficiency_summary(task_entries, grades_by_task_id)
    aggregate["phase"] = "evaluated"
    aggregate["judge_model"] = judge_model

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(_make_json_safe(aggregate), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    logger.info("Saved evaluated results to %s", output_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
