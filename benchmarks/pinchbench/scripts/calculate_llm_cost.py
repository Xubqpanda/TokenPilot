#!/usr/bin/env python3
"""
Calculate LLM token cost from benchmark result JSON files.

- Pricing source: benchmark-maintained USD / 1M token tables for OpenAI + Anthropic.
- Output includes both USD and CNY:
  - USD is direct from pricing table.
  - CNY = USD * fx_usd_cny (default 7.2, configurable).
- OpenAI cache_write_tokens are priced at input-token rate.
- Anthropic supports cache write TTL tiers (5m/1h).
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Literal, Optional


TOKENS_PER_MILLION = 1_000_000.0
DEFAULT_FX_USD_CNY = 7.2


CacheWriteTTL = Literal["5m", "1h"]


# Unified pricing schema:
# - input_per_m_usd
# - output_per_m_usd
# - cache_read_per_m_usd
# - cache_write_5m_per_m_usd
# - cache_write_1h_per_m_usd
PRICE_TABLE_USD: Dict[str, Dict[str, Optional[float]]] = {
    "gpt-5.4": {"input_per_m_usd": 2.50, "cache_read_per_m_usd": 0.25, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 15.00},
    "gpt-5.4-mini": {"input_per_m_usd": 0.75, "cache_read_per_m_usd": 0.075, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 4.50},
    "gpt-5.4-nano": {"input_per_m_usd": 0.20, "cache_read_per_m_usd": 0.02, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 1.25},
    "gpt-5.4-pro": {"input_per_m_usd": 30.00, "cache_read_per_m_usd": None, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 180.00},
    "gpt-5.2": {"input_per_m_usd": 1.75, "cache_read_per_m_usd": 0.175, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 14.00},
    "gpt-5.2-pro": {"input_per_m_usd": 21.00, "cache_read_per_m_usd": None, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 168.00},
    "gpt-5.1": {"input_per_m_usd": 1.25, "cache_read_per_m_usd": 0.125, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 10.00},
    "gpt-5": {"input_per_m_usd": 1.25, "cache_read_per_m_usd": 0.125, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 10.00},
    "gpt-5-mini": {"input_per_m_usd": 0.25, "cache_read_per_m_usd": 0.025, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 2.00},
    "gpt-5-nano": {"input_per_m_usd": 0.05, "cache_read_per_m_usd": 0.005, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 0.40},
    "gpt-5-pro": {"input_per_m_usd": 15.00, "cache_read_per_m_usd": None, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 120.00},
    "gpt-4.1": {"input_per_m_usd": 2.00, "cache_read_per_m_usd": 0.50, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 8.00},
    "gpt-4.1-mini": {"input_per_m_usd": 0.40, "cache_read_per_m_usd": 0.10, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 1.60},
    "gpt-4.1-nano": {"input_per_m_usd": 0.10, "cache_read_per_m_usd": 0.025, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 0.40},
    "gpt-4o": {"input_per_m_usd": 2.50, "cache_read_per_m_usd": 1.25, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 10.00},
    "gpt-4o-mini": {"input_per_m_usd": 0.15, "cache_read_per_m_usd": 0.075, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 0.60},
    "o4-mini": {"input_per_m_usd": 1.10, "cache_read_per_m_usd": 0.275, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 4.40},
    "o3": {"input_per_m_usd": 2.00, "cache_read_per_m_usd": 0.50, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 8.00},
    "o3-mini": {"input_per_m_usd": 1.10, "cache_read_per_m_usd": 0.55, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 4.40},
    "o3-pro": {"input_per_m_usd": 20.00, "cache_read_per_m_usd": None, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 80.00},
    "o1": {"input_per_m_usd": 15.00, "cache_read_per_m_usd": 7.50, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 60.00},
    "o1-mini": {"input_per_m_usd": 1.10, "cache_read_per_m_usd": 0.55, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 4.40},
    "o1-pro": {"input_per_m_usd": 150.00, "cache_read_per_m_usd": None, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 600.00},
    "gpt-4o-2024-05-13": {"input_per_m_usd": 5.00, "cache_read_per_m_usd": None, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 15.00},
    "gpt-4-turbo-2024-04-09": {"input_per_m_usd": 10.00, "cache_read_per_m_usd": None, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 30.00},
    "gpt-4-0125-preview": {"input_per_m_usd": 10.00, "cache_read_per_m_usd": None, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 30.00},
    "gpt-4-1106-preview": {"input_per_m_usd": 10.00, "cache_read_per_m_usd": None, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 30.00},
    "gpt-4-1106-vision-preview": {"input_per_m_usd": 10.00, "cache_read_per_m_usd": None, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 30.00},
    "gpt-4-0613": {"input_per_m_usd": 30.00, "cache_read_per_m_usd": None, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 60.00},
    "gpt-4-0314": {"input_per_m_usd": 30.00, "cache_read_per_m_usd": None, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 60.00},
    "gpt-4-32k": {"input_per_m_usd": 60.00, "cache_read_per_m_usd": None, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 120.00},
    "gpt-3.5-turbo": {"input_per_m_usd": 0.50, "cache_read_per_m_usd": None, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 1.50},
    "gpt-3.5-turbo-0125": {"input_per_m_usd": 0.50, "cache_read_per_m_usd": None, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 1.50},
    "gpt-3.5-turbo-1106": {"input_per_m_usd": 1.00, "cache_read_per_m_usd": None, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 2.00},
    "gpt-3.5-turbo-0613": {"input_per_m_usd": 1.50, "cache_read_per_m_usd": None, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 2.00},
    "gpt-3.5-0301": {"input_per_m_usd": 1.50, "cache_read_per_m_usd": None, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 2.00},
    "gpt-3.5-turbo-instruct": {"input_per_m_usd": 1.50, "cache_read_per_m_usd": None, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 2.00},
    "gpt-3.5-turbo-16k-0613": {"input_per_m_usd": 3.00, "cache_read_per_m_usd": None, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 4.00},
    "davinci-002": {"input_per_m_usd": 2.00, "cache_read_per_m_usd": None, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 2.00},
    "babbage-002": {"input_per_m_usd": 0.40, "cache_read_per_m_usd": None, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 0.40},
    # Specialized - ChatGPT
    "gpt-5.3-chat-latest": {"input_per_m_usd": 1.75, "cache_read_per_m_usd": 0.175, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 14.00},
    "gpt-5.2-chat-latest": {"input_per_m_usd": 1.75, "cache_read_per_m_usd": 0.175, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 14.00},
    "gpt-5.1-chat-latest": {"input_per_m_usd": 1.25, "cache_read_per_m_usd": 0.125, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 10.00},
    "gpt-5-chat-latest": {"input_per_m_usd": 1.25, "cache_read_per_m_usd": 0.125, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 10.00},
    "chatgpt-4o-latest": {"input_per_m_usd": 5.00, "cache_read_per_m_usd": None, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 15.00},
    # Specialized - Codex
    "gpt-5.3-codex": {"input_per_m_usd": 1.75, "cache_read_per_m_usd": 0.175, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 14.00},
    "gpt-5.2-codex": {"input_per_m_usd": 1.75, "cache_read_per_m_usd": 0.175, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 14.00},
    "gpt-5.1-codex-max": {"input_per_m_usd": 1.25, "cache_read_per_m_usd": 0.125, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 10.00},
    "gpt-5.1-codex": {"input_per_m_usd": 1.25, "cache_read_per_m_usd": 0.125, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 10.00},
    "gpt-5-codex": {"input_per_m_usd": 1.25, "cache_read_per_m_usd": 0.125, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 10.00},
    "gpt-5.1-codex-mini": {"input_per_m_usd": 0.25, "cache_read_per_m_usd": 0.025, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 2.00},
    "codex-mini-latest": {"input_per_m_usd": 1.50, "cache_read_per_m_usd": 0.375, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 6.00},
    # Specialized - Search
    "gpt-5-search-api": {"input_per_m_usd": 1.25, "cache_read_per_m_usd": 0.125, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 10.00},
    "gpt-4o-search-preview": {"input_per_m_usd": 2.50, "cache_read_per_m_usd": None, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 10.00},
    "gpt-4o-mini-search-preview": {"input_per_m_usd": 0.15, "cache_read_per_m_usd": None, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 0.60},
    # Specialized - Deep research
    "o3-deep-research": {"input_per_m_usd": 10.00, "cache_read_per_m_usd": 2.50, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 40.00},
    "o4-mini-deep-research": {"input_per_m_usd": 2.00, "cache_read_per_m_usd": 0.50, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 8.00},
    # Specialized - Computer use
    "computer-use-preview": {"input_per_m_usd": 3.00, "cache_read_per_m_usd": None, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 12.00},
    # Specialized - Embeddings (no output-token billing)
    "text-embedding-3-small": {"input_per_m_usd": 0.02, "cache_read_per_m_usd": None, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 0.0},
    "text-embedding-3-large": {"input_per_m_usd": 0.13, "cache_read_per_m_usd": None, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 0.0},
    "text-embedding-ada-002": {"input_per_m_usd": 0.10, "cache_read_per_m_usd": None, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 0.0},
    # Specialized - Moderation (free)
    "omni-moderation-latest": {"input_per_m_usd": 0.0, "cache_read_per_m_usd": None, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 0.0},
    "text-moderation-latest": {"input_per_m_usd": 0.0, "cache_read_per_m_usd": None, "cache_write_5m_per_m_usd": 0.0, "cache_write_1h_per_m_usd": 0.0, "output_per_m_usd": 0.0},
    # Anthropic (Claude) with explicit prompt-caching tiers.
    "claude-opus-4-6": {"input_per_m_usd": 5.0, "cache_read_per_m_usd": 0.50, "cache_write_5m_per_m_usd": 6.25, "cache_write_1h_per_m_usd": 10.0, "output_per_m_usd": 25.0},
    "claude-opus-4-5": {"input_per_m_usd": 5.0, "cache_read_per_m_usd": 0.50, "cache_write_5m_per_m_usd": 6.25, "cache_write_1h_per_m_usd": 10.0, "output_per_m_usd": 25.0},
    "claude-opus-4-1": {"input_per_m_usd": 15.0, "cache_read_per_m_usd": 1.50, "cache_write_5m_per_m_usd": 18.75, "cache_write_1h_per_m_usd": 30.0, "output_per_m_usd": 75.0},
    "claude-opus-4": {"input_per_m_usd": 15.0, "cache_read_per_m_usd": 1.50, "cache_write_5m_per_m_usd": 18.75, "cache_write_1h_per_m_usd": 30.0, "output_per_m_usd": 75.0},
    "claude-sonnet-4-6": {"input_per_m_usd": 3.0, "cache_read_per_m_usd": 0.30, "cache_write_5m_per_m_usd": 3.75, "cache_write_1h_per_m_usd": 6.0, "output_per_m_usd": 15.0},
    "claude-sonnet-4-5": {"input_per_m_usd": 3.0, "cache_read_per_m_usd": 0.30, "cache_write_5m_per_m_usd": 3.75, "cache_write_1h_per_m_usd": 6.0, "output_per_m_usd": 15.0},
    "claude-sonnet-4": {"input_per_m_usd": 3.0, "cache_read_per_m_usd": 0.30, "cache_write_5m_per_m_usd": 3.75, "cache_write_1h_per_m_usd": 6.0, "output_per_m_usd": 15.0},
    "claude-sonnet-3-7": {"input_per_m_usd": 3.0, "cache_read_per_m_usd": 0.30, "cache_write_5m_per_m_usd": 3.75, "cache_write_1h_per_m_usd": 6.0, "output_per_m_usd": 15.0},
    "claude-haiku-4-5": {"input_per_m_usd": 1.0, "cache_read_per_m_usd": 0.10, "cache_write_5m_per_m_usd": 1.25, "cache_write_1h_per_m_usd": 2.0, "output_per_m_usd": 5.0},
    "claude-haiku-3-5": {"input_per_m_usd": 0.80, "cache_read_per_m_usd": 0.08, "cache_write_5m_per_m_usd": 1.0, "cache_write_1h_per_m_usd": 1.6, "output_per_m_usd": 4.0},
    "claude-opus-3": {"input_per_m_usd": 15.0, "cache_read_per_m_usd": 1.50, "cache_write_5m_per_m_usd": 18.75, "cache_write_1h_per_m_usd": 30.0, "output_per_m_usd": 75.0},
    "claude-haiku-3": {"input_per_m_usd": 0.25, "cache_read_per_m_usd": 0.03, "cache_write_5m_per_m_usd": 0.30, "cache_write_1h_per_m_usd": 0.50, "output_per_m_usd": 1.25},
}

MODEL_ALIASES: Dict[str, str] = {
    # Anthropic alternate naming patterns
    "claude-3-7-sonnet": "claude-sonnet-3-7",
    "claude-3-5-haiku": "claude-haiku-3-5",
}


def _to_int(value: Any, default: int = 0) -> int:
    try:
        if value is None:
            return default
        return int(value)
    except (TypeError, ValueError):
        return default


def normalize_model_name(raw_model: str | None) -> str:
    if not raw_model:
        return ""
    base = str(raw_model).strip().lower()
    if "/" in base:
        base = base.split("/")[-1]
    return base.replace("_", "-")


def resolve_price_key(raw_model: str | None) -> str | None:
    model = normalize_model_name(raw_model)
    if not model:
        return None
    if model in MODEL_ALIASES:
        return MODEL_ALIASES[model]
    if model in PRICE_TABLE_USD:
        return model
    for alias, canonical in sorted(MODEL_ALIASES.items(), key=lambda kv: len(kv[0]), reverse=True):
        if model.startswith(alias):
            return canonical
    # Fallback for some alias forms without separators.
    compact = model.replace("-", "").replace(".", "")
    for key in PRICE_TABLE_USD:
        if compact == key.replace("-", "").replace(".", ""):
            return key
    # Prefix match (e.g. claude-sonnet-4-5-20260101).
    keys = sorted(PRICE_TABLE_USD.keys(), key=len, reverse=True)
    for key in keys:
        if model.startswith(key):
            return key
    for key in keys:
        if compact.startswith(key.replace("-", "").replace(".", "")):
            return key
    return None


def resolve_input_path(path_like: str) -> Path:
    p = Path(path_like)
    if p.is_file():
        return p
    if p.is_dir():
        files = sorted(p.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True)
        if not files:
            raise FileNotFoundError(f"No JSON files found in directory: {p}")
        return files[0]
    raise FileNotFoundError(f"Path not found: {p}")


def iter_calls(payload: Dict[str, Any]) -> Iterable[Dict[str, Any]]:
    for task in payload.get("tasks", []):
        task_id = task.get("task_id")
        for call in task.get("llm_calls", []) or []:
            call_copy = dict(call)
            call_copy["task_id"] = task_id
            yield call_copy


def _extract_token_usage(call: Dict[str, Any]) -> Dict[str, int]:
    input_tokens = _to_int(call.get("input_tokens"), 0)
    output_tokens = _to_int(call.get("output_tokens"), 0)
    cache_read_tokens = _to_int(call.get("cache_read_tokens"), _to_int(call.get("cached_tokens"), 0))
    cache_write_tokens = _to_int(
        call.get("cache_write_tokens"),
        _to_int(call.get("cache_creation_input_tokens"), 0),
    )
    if cache_read_tokens == 0:
        cache_read_tokens = _to_int(call.get("cache_read_input_tokens"), 0)
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_read_tokens": cache_read_tokens,
        "cache_write_tokens": cache_write_tokens,
    }


def call_cost_usd(call: Dict[str, Any], cache_write_ttl: CacheWriteTTL = "5m") -> tuple[Optional[float], Optional[str]]:
    price_key = resolve_price_key(call.get("model"))
    if not price_key:
        return None, None
    price = PRICE_TABLE_USD[price_key]
    usage = _extract_token_usage(call)
    input_tokens = usage["input_tokens"]
    output_tokens = usage["output_tokens"]
    cache_read_tokens = usage["cache_read_tokens"]
    cache_write_tokens = usage["cache_write_tokens"]

    input_rate = float(price["input_per_m_usd"] or 0.0)
    output_rate = float(price["output_per_m_usd"] or 0.0)
    cached_rate = price.get("cache_read_per_m_usd")
    # If model has no cached-input pricing, fall back to normal input pricing.
    cache_read_rate = float(cached_rate if cached_rate is not None else input_rate)
    if price_key.startswith("claude-"):
        write_key = "cache_write_1h_per_m_usd" if cache_write_ttl == "1h" else "cache_write_5m_per_m_usd"
        cache_write_rate = float(price.get(write_key) or 0.0)
    else:
        # OpenAI-family: treat cache write at base input rate.
        cache_write_rate = input_rate

    cost = (
        (input_tokens / TOKENS_PER_MILLION) * input_rate
        + (output_tokens / TOKENS_PER_MILLION) * output_rate
        + (cache_read_tokens / TOKENS_PER_MILLION) * cache_read_rate
        + (cache_write_tokens / TOKENS_PER_MILLION) * cache_write_rate
    )
    return cost, price_key


def build_report(
    input_file: Path,
    payload: Dict[str, Any],
    fx_usd_cny: float = DEFAULT_FX_USD_CNY,
    cache_write_ttl: CacheWriteTTL = "5m",
) -> Dict[str, Any]:
    totals = {
        "requests": 0,
        "priced_requests": 0,
        "unpriced_requests": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "total_tokens": 0,
        "cost_usd": 0.0,
        "cost_cny": 0.0,
    }
    per_model = defaultdict(
        lambda: {
            "requests": 0,
            "priced_requests": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
            "total_tokens": 0,
            "cost_usd": 0.0,
            "cost_cny": 0.0,
            "price_key": None,
        }
    )
    per_task = defaultdict(
        lambda: {
            "requests": 0,
            "priced_requests": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
            "total_tokens": 0,
            "cost_usd": 0.0,
            "cost_cny": 0.0,
        }
    )
    unknown_models = set()

    for call in iter_calls(payload):
        totals["requests"] += 1
        model_name = str(call.get("model") or "unknown")
        task_id = str(call.get("task_id") or "unknown")
        model_bucket = per_model[model_name]
        task_bucket = per_task[task_id]
        model_bucket["requests"] += 1
        task_bucket["requests"] += 1

        usage = _extract_token_usage(call)
        input_tokens = usage["input_tokens"]
        output_tokens = usage["output_tokens"]
        cache_read_tokens = usage["cache_read_tokens"]
        cache_write_tokens = usage["cache_write_tokens"]
        total_tokens = _to_int(
            call.get("total_tokens"),
            input_tokens + output_tokens + cache_read_tokens + cache_write_tokens,
        )

        for bucket in (totals, model_bucket, task_bucket):
            bucket["input_tokens"] += input_tokens
            bucket["output_tokens"] += output_tokens
            bucket["cache_read_tokens"] += cache_read_tokens
            bucket["cache_write_tokens"] += cache_write_tokens
            bucket["total_tokens"] += total_tokens

        cost_usd, price_key = call_cost_usd(call, cache_write_ttl=cache_write_ttl)
        if cost_usd is None:
            totals["unpriced_requests"] += 1
            unknown_models.add(model_name)
        else:
            cost_cny = cost_usd * fx_usd_cny
            totals["priced_requests"] += 1
            totals["cost_usd"] += cost_usd
            totals["cost_cny"] += cost_cny
            model_bucket["priced_requests"] += 1
            task_bucket["priced_requests"] += 1
            model_bucket["cost_usd"] += cost_usd
            model_bucket["cost_cny"] += cost_cny
            task_bucket["cost_usd"] += cost_usd
            task_bucket["cost_cny"] += cost_cny
            model_bucket["price_key"] = price_key

    report = {
        "input_file": str(input_file),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "fx_usd_cny": fx_usd_cny,
        "cache_write_ttl": cache_write_ttl,
        "price_unit": "USD per 1M tokens",
        "totals": {
            **totals,
            "cost_usd": round(totals["cost_usd"], 6),
            "cost_cny": round(totals["cost_cny"], 6),
        },
        "by_model": [
            {
                "model": model,
                **vals,
                "cost_usd": round(vals["cost_usd"], 6),
                "cost_cny": round(vals["cost_cny"], 6),
            }
            for model, vals in sorted(
                per_model.items(),
                key=lambda item: item[1]["cost_usd"],
                reverse=True,
            )
        ],
        "by_task": [
            {
                "task_id": task_id,
                **vals,
                "cost_usd": round(vals["cost_usd"], 6),
                "cost_cny": round(vals["cost_cny"], 6),
            }
            for task_id, vals in sorted(
                per_task.items(),
                key=lambda item: item[1]["cost_usd"],
                reverse=True,
            )
        ],
        "unknown_models": sorted(unknown_models),
        "notes": [
            "Cost is computed from llm_calls token fields only.",
            "OpenAI cache_write_tokens are priced at input-token rate.",
            "Anthropic cache_write_tokens use selected TTL tier pricing.",
            "Unknown models are excluded from cost totals.",
        ],
        "pricing_usd": PRICE_TABLE_USD,
    }
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Calculate LLM cost from benchmark JSON")
    parser.add_argument(
        "--input",
        required=True,
        help="Result JSON file path, or directory containing JSON files (latest is used).",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Output report JSON path. Default: <input>.cost.json",
    )
    parser.add_argument(
        "--fx-usd-cny",
        type=float,
        default=DEFAULT_FX_USD_CNY,
        help=f"FX rate for CNY conversion (default: {DEFAULT_FX_USD_CNY}).",
    )
    parser.add_argument(
        "--cache-write-ttl",
        choices=("5m", "1h"),
        default="5m",
        help="Cache-write pricing tier when provider has tiered write pricing (default: 5m).",
    )
    parser.add_argument(
        "--print",
        action="store_true",
        dest="print_stdout",
        help="Print report JSON to stdout.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    input_file = resolve_input_path(args.input)
    payload = json.loads(input_file.read_text(encoding="utf-8"))
    report = build_report(
        input_file,
        payload,
        fx_usd_cny=float(args.fx_usd_cny),
        cache_write_ttl=args.cache_write_ttl,
    )

    if args.output:
        output_path = Path(args.output)
    else:
        output_path = input_file.with_suffix(".cost.json")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Cost report written to: {output_path}")

    if args.print_stdout:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
