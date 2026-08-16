#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def extract_score(task: dict[str, Any]) -> float:
    grading = task.get("grading") or {}
    score = grading.get("mean")
    if score is None:
        runs = grading.get("runs") or []
        if runs and isinstance(runs[0], dict):
            score = runs[0].get("score")
    return float(score or 0.0)


def aggregate_calls(task: dict[str, Any]) -> dict[str, int]:
    acc = {
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "total_tokens": 0,
        "request_count": 0,
    }
    for call in task.get("llm_calls") or []:
        acc["input_tokens"] += int(call.get("input_tokens") or 0)
        acc["output_tokens"] += int(call.get("output_tokens") or 0)
        acc["cache_read_tokens"] += int(call.get("cache_read_tokens") or 0)
        acc["cache_write_tokens"] += int(call.get("cache_write_tokens") or 0)
        acc["total_tokens"] += int(call.get("total_tokens") or 0)
        acc["request_count"] += 1
    return acc


def merge_files(inputs: list[Path]) -> dict[str, Any]:
    merged_tasks: dict[str, dict[str, Any]] = {}
    first_meta: dict[str, Any] | None = None
    source_files: list[str] = []

    for path in inputs:
        data = load_json(path)
        source_files.append(str(path))
        if first_meta is None:
            first_meta = {k: v for k, v in data.items() if k != "tasks"}
        for task in data.get("tasks") or []:
            task_id = task.get("task_id")
            if not task_id:
                continue
            merged_tasks[task_id] = task

    if first_meta is None:
        raise ValueError("No input files")

    ordered_tasks = sorted(merged_tasks.values(), key=lambda t: t.get("task_id", ""))

    total_score = sum(extract_score(task) for task in ordered_tasks)
    totals = {
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "total_tokens": 0,
        "request_count": 0,
    }
    for task in ordered_tasks:
        agg = aggregate_calls(task)
        for key, value in agg.items():
            totals[key] += value

    merged = dict(first_meta)
    merged["tasks"] = ordered_tasks
    merged["merged_from"] = source_files
    merged["task_count"] = len(ordered_tasks)
    merged["score_sum"] = total_score
    merged["mean_score"] = total_score / len(ordered_tasks) if ordered_tasks else 0.0
    merged["usage_summary"] = totals
    return merged


def write_csv(merged: dict[str, Any], output_csv: Path) -> None:
    rows = []
    for task in merged.get("tasks") or []:
        agg = aggregate_calls(task)
        rows.append(
            {
                "task_id": task.get("task_id"),
                "score": extract_score(task),
                **agg,
            }
        )
    with output_csv.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(
            fh,
            fieldnames=[
                "task_id",
                "score",
                "request_count",
                "input_tokens",
                "output_tokens",
                "cache_read_tokens",
                "cache_write_tokens",
                "total_tokens",
            ],
        )
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description="Merge PinchBench result JSON files by task_id.")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--csv-output", type=Path)
    parser.add_argument("inputs", nargs="+", type=Path)
    args = parser.parse_args()

    merged = merge_files(args.inputs)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as fh:
        json.dump(merged, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    if args.csv_output:
        args.csv_output.parent.mkdir(parents=True, exist_ok=True)
        write_csv(merged, args.csv_output)

    print(f"Merged {len(args.inputs)} files into {args.output}")
    print(f"Tasks: {merged['task_count']}")
    print(f"Mean score: {merged['mean_score']:.6f}")
    print(f"Requests: {merged['usage_summary']['request_count']}")
    print(f"Input: {merged['usage_summary']['input_tokens']}")
    print(f"Output: {merged['usage_summary']['output_tokens']}")
    print(f"Cache read: {merged['usage_summary']['cache_read_tokens']}")
    print(f"Total tokens: {merged['usage_summary']['total_tokens']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
