import json
import math
import re
import sys
from typing import List, Tuple
from urllib import request as urllib_request

import numpy as np
import torch
from sentence_transformers import SentenceTransformer
from transformers import AutoModelForTokenClassification, AutoTokenizer


LOCAL_EMBEDDER_CACHE = {}
TOKENIZER_CACHE = {}
MODEL_CACHE = {}


def split_chunks(text: str, max_chunk_chars: int) -> List[str]:
    raw_blocks = [block.strip() for block in re.split(r"\n\s*\n", text) if block.strip()]
    if not raw_blocks:
        raw_blocks = [text.strip()]
    chunks: List[str] = []
    current = ""
    for block in raw_blocks:
        candidate = block if not current else f"{current}\n\n{block}"
        if len(candidate) <= max_chunk_chars or not current:
            current = candidate
            continue
        chunks.append(current)
        if len(block) <= max_chunk_chars:
          current = block
          continue
        start = 0
        while start < len(block):
            piece = block[start : start + max_chunk_chars].strip()
            if piece:
                chunks.append(piece)
            start += max_chunk_chars
        current = ""
    if current:
        chunks.append(current)
    return [chunk for chunk in chunks if chunk.strip()]


def get_embedder(model_path: str) -> SentenceTransformer:
    embedder = LOCAL_EMBEDDER_CACHE.get(model_path)
    if embedder is None:
        embedder = SentenceTransformer(model_path)
        LOCAL_EMBEDDER_CACHE[model_path] = embedder
    return embedder


def local_similarity(query: str, chunks: List[str], model_path: str) -> List[float]:
    embedder = get_embedder(model_path)
    embeddings = embedder.encode([query, *chunks], normalize_embeddings=True)
    query_vec = embeddings[0]
    scores = []
    for chunk_vec in embeddings[1:]:
        scores.append(float(np.dot(query_vec, chunk_vec)))
    return scores


def api_similarity(query: str, chunks: List[str], cfg: dict) -> List[float]:
    base_url = str(cfg.get("api_base_url") or "").rstrip("/")
    api_key = str(cfg.get("api_key") or "").strip()
    model = str(cfg.get("api_model") or "").strip()
    if not base_url or not api_key or not model:
        raise RuntimeError("embedding_api_config_missing")

    payload = json.dumps({"model": model, "input": [query, *chunks]}).encode("utf-8")
    req = urllib_request.Request(
        f"{base_url}/embeddings",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    timeout = max(1, int(cfg.get("request_timeout_ms", 30000)) / 1000.0)
    with urllib_request.urlopen(req, timeout=timeout) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    rows = body.get("data") or []
    vectors = [np.asarray(row["embedding"], dtype=np.float32) for row in rows]
    if len(vectors) != len(chunks) + 1:
        raise RuntimeError("embedding_api_response_size_mismatch")
    query_vec = vectors[0]
    query_norm = np.linalg.norm(query_vec)
    scores = []
    for vec in vectors[1:]:
        denom = max(np.linalg.norm(vec) * query_norm, 1e-12)
        scores.append(float(np.dot(query_vec, vec) / denom))
    return scores


def rank_chunks(query: str, chunks: List[str], embedding_cfg: dict) -> Tuple[List[int], str, str]:
    provider = str(embedding_cfg.get("provider") or "none")
    if provider == "local":
        model_path = str(embedding_cfg.get("model_path") or "").strip()
        if not model_path:
            return list(range(len(chunks))), "none", "embedding_local_model_missing"
        try:
            scores = local_similarity(query, chunks, model_path)
            ranked = sorted(range(len(chunks)), key=lambda i: scores[i], reverse=True)
            return ranked, "local", ""
        except Exception as exc:
            return list(range(len(chunks))), "none", f"embedding_local_failed:{exc}"
    if provider == "api":
        try:
            scores = api_similarity(query, chunks, embedding_cfg)
            ranked = sorted(range(len(chunks)), key=lambda i: scores[i], reverse=True)
            return ranked, "api", ""
        except Exception as exc:
            return list(range(len(chunks))), "none", f"embedding_api_failed:{exc}"
    return list(range(len(chunks))), "none", ""


def load_llmlingua2(model_path: str):
    tokenizer = TOKENIZER_CACHE.get(model_path)
    model = MODEL_CACHE.get(model_path)
    if tokenizer is None:
        tokenizer = AutoTokenizer.from_pretrained(model_path)
        TOKENIZER_CACHE[model_path] = tokenizer
    if model is None:
        model = AutoModelForTokenClassification.from_pretrained(model_path)
        model.eval()
        MODEL_CACHE[model_path] = model
    return tokenizer, model


def compress_chunk(text: str, tokenizer, model, keep_ratio: float) -> str:
    words = re.findall(r"\S+", text)
    if len(words) < 6:
        return text.strip()

    scores = []
    chunk_words = 220
    for start in range(0, len(words), chunk_words):
        word_slice = words[start : start + chunk_words]
        if not word_slice:
            continue
        encoded = tokenizer(
            word_slice,
            is_split_into_words=True,
            return_tensors="pt",
            truncation=True,
            max_length=512,
        )
        with torch.no_grad():
            probs = model(**encoded).logits.softmax(-1)[0, :, 1]
        word_scores = {}
        for idx, word_id in enumerate(encoded.word_ids()):
            if word_id is None:
                continue
            score = float(probs[idx])
            word_scores[word_id] = max(word_scores.get(word_id, 0.0), score)
        for local_idx in range(len(word_slice)):
            scores.append(word_scores.get(local_idx, 0.0))

    keep_count = max(1, math.ceil(len(words) * keep_ratio))
    ranked = sorted(range(len(scores)), key=lambda idx: scores[idx], reverse=True)[:keep_count]
    keep = set(ranked)

    preserved = []
    for idx, word in enumerate(words):
        force_keep = bool(re.search(r"[.!?,:;]$", word)) and idx > 0 and idx < len(words) - 1
        if idx in keep or force_keep:
            preserved.append(word)
    return " ".join(preserved).strip() or text.strip()


def main() -> int:
    payload = json.loads(sys.stdin.read())
    text = str(payload.get("text") or "")
    query = str(payload.get("query") or "")
    model_path = str(payload.get("llmlingua_model_path") or "").strip()
    if not text.strip():
        print(json.dumps({"ok": True, "changed": False, "skipped_reason": "empty_content"}))
        return 0
    if not model_path:
        print(json.dumps({"ok": False, "skipped_reason": "semantic_model_path_missing"}))
        return 0

    target_ratio = min(0.95, max(0.05, float(payload.get("target_ratio") or 0.55)))
    preselect_ratio = min(1.0, max(target_ratio, float(payload.get("preselect_ratio") or 0.8)))
    max_chunk_chars = max(256, int(payload.get("max_chunk_chars") or 1400))
    chunks = split_chunks(text, max_chunk_chars)
    ranked, embedding_provider, warning = rank_chunks(query, chunks, payload.get("embedding") or {})

    selected = []
    selected_chars = 0
    budget = max(1, math.ceil(len(text) * preselect_ratio))
    for idx in ranked:
        chunk = chunks[idx]
        selected.append((idx, chunk))
        selected_chars += len(chunk)
        if selected_chars >= budget:
            break
    if not selected:
        selected = list(enumerate(chunks[:1]))
    selected.sort(key=lambda item: item[0])
    selected_chunks = [chunk for _, chunk in selected]

    tokenizer, model = load_llmlingua2(model_path)
    keep_ratio = min(0.95, max(0.05, target_ratio / max(preselect_ratio, 1e-6)))
    compressed_chunks = [compress_chunk(chunk, tokenizer, model, keep_ratio) for chunk in selected_chunks]
    compressed_text = "\n\n".join(chunk for chunk in compressed_chunks if chunk.strip()).strip()

    changed = len(compressed_text) < len(text)
    result = {
        "ok": True,
        "changed": changed,
        "compressed_text": compressed_text if changed else text,
        "stats": {
            "original_chars": len(text),
            "compressed_chars": len(compressed_text) if changed else len(text),
            "selected_chunk_count": len(selected_chunks),
            "total_chunk_count": len(chunks),
            "embedding_provider": embedding_provider,
            "target_ratio": target_ratio,
        },
        "note": f"semantic_llmlingua2:{embedding_provider}:chunks={len(selected_chunks)}/{len(chunks)}",
        "warning": warning or None,
        "skipped_reason": None if changed else "semantic_no_savings",
    }
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
