"""Загрузка базы знаний из Markdown и полнотекстовый поиск BM25.

BM25 выбран намеренно: он не требует платных эмбеддингов, не расходует лимиты
LLM-провайдера и даёт детерминированный, покрываемый тестами результат.
Для базы знаний объёмом в десятки страниц этого достаточно; при росте базы
класс BM25Index заменяется векторным хранилищем без изменения API сервиса.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from .text import GENERIC_WORDS, normalize

GENERIC_STEMS = frozenset(t for w in GENERIC_WORDS for t in normalize(w))

_H1 = re.compile(r"^#\s+(.+)$")
_H2 = re.compile(r"^##\s+(.+)$")


@dataclass(frozen=True)
class Chunk:
    id: str
    source: str
    title: str
    section: str
    text: str

    @property
    def searchable(self) -> str:
        return f"{self.title}. {self.section}. {self.text}"


def split_markdown(path: Path) -> list[Chunk]:
    """Делит документ на фрагменты по заголовкам второго уровня."""
    title = path.stem
    section = ""
    buffer: list[str] = []
    chunks: list[Chunk] = []

    def flush() -> None:
        body = "\n".join(buffer).strip()
        if body:
            chunks.append(
                Chunk(
                    id=f"{path.stem}#{len(chunks)}",
                    source=path.name,
                    title=title,
                    section=section or title,
                    text=body,
                )
            )
        buffer.clear()

    for line in path.read_text(encoding="utf-8").splitlines():
        if m := _H1.match(line):
            flush()
            title = m.group(1).strip()
        elif m := _H2.match(line):
            flush()
            section = m.group(1).strip()
        else:
            buffer.append(line)
    flush()
    return chunks


def load_chunks(directory: Path) -> list[Chunk]:
    chunks: list[Chunk] = []
    for path in sorted(directory.glob("*.md")):
        chunks.extend(split_markdown(path))
    return chunks


@dataclass
class SearchHit:
    chunk: Chunk
    score: float


@dataclass
class BM25Index:
    chunks: list[Chunk]
    k1: float = 1.5
    b: float = 0.75
    _docs: list[Counter] = field(init=False, repr=False)
    _lengths: list[int] = field(init=False, repr=False)
    _idf: dict[str, float] = field(init=False, repr=False)
    _avgdl: float = field(init=False, repr=False)

    def __post_init__(self) -> None:
        tokenized = [normalize(c.searchable) for c in self.chunks]
        self._docs = [Counter(t) for t in tokenized]
        self._lengths = [len(t) for t in tokenized]
        self._avgdl = (sum(self._lengths) / len(self._lengths)) if self._lengths else 0.0
        n = len(self._docs)
        df: Counter = Counter()
        for doc in self._docs:
            df.update(doc.keys())
        self._idf = {term: math.log(1 + (n - freq + 0.5) / (freq + 0.5)) for term, freq in df.items()}

    def _score(self, query_terms: list[str], i: int) -> float:
        doc, length = self._docs[i], self._lengths[i]
        score = 0.0
        for term in query_terms:
            tf = doc.get(term, 0)
            if not tf:
                continue
            denom = tf + self.k1 * (1 - self.b + self.b * length / self._avgdl)
            score += self._idf[term] * tf * (self.k1 + 1) / denom
        return score

    def _has_topic_match(self, query_terms: list[str], i: int) -> bool:
        """Совпадение должно быть хотя бы по одному предметному слову, а не только по «сколько стоит»."""
        doc = self._docs[i]
        return any(t in doc for t in query_terms if t not in GENERIC_STEMS)

    def search(self, query: str, k: int = 3, min_score: float = 0.0) -> list[SearchHit]:
        terms = list(dict.fromkeys(normalize(query, expand_synonyms=True)))
        if not terms or not self.chunks:
            return []
        hits = [
            SearchHit(c, self._score(terms, i))
            for i, c in enumerate(self.chunks)
            if self._has_topic_match(terms, i)
        ]
        hits = [h for h in hits if h.score > 0 and h.score >= min_score]
        hits.sort(key=lambda h: h.score, reverse=True)
        return hits[:k]
