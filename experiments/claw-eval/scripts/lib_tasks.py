from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

import yaml


@dataclass
class ClawEvalTask:
    task_id: str
    task_name: str
    category: str
    split: str
    language: str
    prompt: str
    attachments: List[str] = field(default_factory=list)
    declared_tools: List[str] = field(default_factory=list)
    services: List[Dict[str, Any]] = field(default_factory=list)
    fixtures: List[str] = field(default_factory=list)
    grader_path: Optional[Path] = None
    task_yaml_path: Optional[Path] = None
    timeout_seconds: int = 300
    frontmatter: Dict[str, Any] = field(default_factory=dict)


class ClawEvalTaskLoader:
    def __init__(self, tasks_dir: Path):
        self.tasks_dir = tasks_dir

    def discover_task_files(self) -> List[Path]:
        return sorted(self.tasks_dir.rglob("task.yaml"))

    def load_all_tasks(self) -> List[ClawEvalTask]:
        return [self.load_task(path) for path in self.discover_task_files()]

    def load_task(self, task_yaml_path: Path) -> ClawEvalTask:
        raw = yaml.safe_load(task_yaml_path.read_text(encoding="utf-8")) or {}

        task_id = str(raw.get("task_id") or task_yaml_path.parent.name)
        task_name = str(raw.get("task_name") or task_id)
        category = str(raw.get("category") or "")
        split = str(raw.get("split") or self._infer_split(task_yaml_path))
        language = str(raw.get("language") or "")

        prompt_field = raw.get("prompt", "")
        if isinstance(prompt_field, dict):
            prompt = str(prompt_field.get("text") or "")
            attachments = [str(item) for item in (prompt_field.get("attachments") or []) if item]
        else:
            prompt = str(prompt_field or "")
            attachments = []

        declared_tools = self._extract_declared_tools(
            raw.get("declared_tools") or raw.get("tools") or []
        )
        services = list(raw.get("services") or [])
        fixtures = self._extract_fixture_paths(raw)
        grader_path = task_yaml_path.parent / "grader.py"
        timeout_seconds = int((raw.get("environment") or {}).get("timeout_seconds", 300))

        frontmatter = dict(raw)
        frontmatter["_source"] = str(task_yaml_path)

        return ClawEvalTask(
            task_id=task_id,
            task_name=task_name,
            category=category,
            split=split,
            language=language,
            prompt=prompt,
            attachments=attachments,
            declared_tools=declared_tools,
            services=services,
            fixtures=fixtures,
            grader_path=grader_path if grader_path.exists() else None,
            task_yaml_path=task_yaml_path,
            timeout_seconds=timeout_seconds,
            frontmatter=frontmatter,
        )

    def select_tasks(self, tasks: Iterable[ClawEvalTask], suite: str) -> List[ClawEvalTask]:
        suite = (suite or "all").strip()
        tasks = list(tasks)
        if suite == "all":
            return tasks

        split_names = {task.split for task in tasks if task.split}
        category_names = {task.category for task in tasks if task.category}

        if suite in split_names:
            return [task for task in tasks if task.split == suite]
        if suite in category_names:
            return [task for task in tasks if task.category == suite]

        wanted_ids = {item.strip() for item in suite.split(",") if item.strip()}
        if not wanted_ids:
            return tasks
        return [task for task in tasks if task.task_id in wanted_ids]

    @staticmethod
    def _extract_declared_tools(tools_raw: List[Any]) -> List[str]:
        declared: List[str] = []
        for tool in tools_raw:
            if isinstance(tool, dict):
                name = tool.get("name")
            else:
                name = tool
            if name:
                declared.append(str(name))
        return declared

    @staticmethod
    def _extract_fixture_paths(raw: Dict[str, Any]) -> List[str]:
        fixtures: List[str] = []
        fixture_field = raw.get("fixture")
        if isinstance(fixture_field, list):
            fixtures.extend(str(item) for item in fixture_field if item)
        elif fixture_field:
            fixtures.append(str(fixture_field))

        env_block = ((raw.get("environment") or {}).get("env") or {})
        for value in env_block.values():
            if isinstance(value, str) and ("tasks/" in value or "fixtures/" in value):
                fixtures.append(value)
        return fixtures

    @staticmethod
    def _infer_split(task_yaml_path: Path) -> str:
        # Prefer an explicit split field in task.yaml. Fallback to path heuristics only.
        parent_name = task_yaml_path.parent.name
        if parent_name.startswith("M"):
            return "multimodal"
        return "general"
