"""HTTP-сервис базы знаний для ИИ-консультанта.

Агент n8n вызывает GET /search как инструмент (HTTP Request Tool) и получает
релевантные фрагменты, на основе которых формирует ответ посетителю.
"""

from __future__ import annotations

import logging
import os
import threading
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Query
from pydantic import BaseModel

from .index import BM25Index, load_chunks

KNOWLEDGE_DIR = Path(os.getenv("KNOWLEDGE_DIR", Path(__file__).resolve().parent.parent / "knowledge"))
MIN_SCORE = float(os.getenv("KB_MIN_SCORE", "1.5"))
ADMIN_TOKEN = os.getenv("KB_ADMIN_TOKEN", "")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("kb-service")

app = FastAPI(title="Knowledge Base Service", version="1.0.0")
_lock = threading.Lock()
_index: BM25Index | None = None


def build_index() -> BM25Index:
    chunks = load_chunks(KNOWLEDGE_DIR)
    log.info("База знаний загружена: %d фрагментов из %s", len(chunks), KNOWLEDGE_DIR)
    return BM25Index(chunks)


def get_index() -> BM25Index:
    global _index
    with _lock:
        if _index is None:
            _index = build_index()
        return _index


class Fragment(BaseModel):
    source: str
    section: str
    text: str
    score: float


class SearchResponse(BaseModel):
    query: str
    found: bool
    results: list[Fragment]
    hint: str


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "chunks": len(get_index().chunks)}


@app.get("/search", response_model=SearchResponse)
def search(
    q: str = Query(..., min_length=2, max_length=500, description="Вопрос посетителя"),
    k: int = Query(3, ge=1, le=10),
) -> SearchResponse:
    hits = get_index().search(q, k=k, min_score=MIN_SCORE)
    log.info("search q=%r hits=%d top=%.2f", q, len(hits), hits[0].score if hits else 0.0)
    results = [
        Fragment(source=h.chunk.source, section=h.chunk.section, text=h.chunk.text, score=round(h.score, 3))
        for h in hits
    ]
    hint = (
        "Отвечай только на основе этих фрагментов."
        if results
        else "В базе знаний нет ответа. Не придумывай факты, предложи связаться с менеджером."
    )
    return SearchResponse(query=q, found=bool(results), results=results, hint=hint)


@app.post("/reload")
def reload(x_admin_token: str = Header(default="")) -> dict:
    """Перечитывает Markdown-файлы без перезапуска контейнера."""
    if not ADMIN_TOKEN or x_admin_token != ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail="forbidden")
    global _index
    new_index = build_index()
    with _lock:
        _index = new_index
    return {"status": "reloaded", "chunks": len(new_index.chunks)}
