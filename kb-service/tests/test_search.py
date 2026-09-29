from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.index import BM25Index, load_chunks, split_markdown
from app.main import app
from app.text import normalize

KNOWLEDGE = Path(__file__).resolve().parent.parent / "knowledge"


@pytest.fixture(scope="module")
def index() -> BM25Index:
    return BM25Index(load_chunks(KNOWLEDGE))


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(app)


def test_normalize_removes_stop_words_and_stems():
    assert normalize("Подскажите, пожалуйста, ремонт квартиры") == normalize("ремонт квартир")
    assert normalize("ремонт и отделка") == ["ремонт", "отделк"]
    assert "цен" in normalize("сколько стоит", expand_synonyms=True)


def test_markdown_is_split_by_sections():
    chunks = split_markdown(KNOWLEDGE / "02_services_prices.md")
    sections = {c.section for c in chunks}
    assert {"Косметический ремонт", "Капитальный ремонт", "Ремонт санузла"} <= sections


@pytest.mark.parametrize(
    ("question", "expected_section"),
    [
        ("Сколько стоит капитальный ремонт?", "Капитальный ремонт"),
        ("Какая у вас гарантия?", "Гарантия"),
        ("Можно ли оплатить в рассрочку?", "Оплата"),
        ("Сколько стоит ремонт ванной?", "Ремонт санузла"),
        ("Замер платный?", "Сколько стоит замер?"),
        ("Вывозите строительный мусор?", "Вывозите ли вы мусор?"),
        ("Где находится ваш офис и какой режим работы?", "Контакты и режим работы"),
        ("Делаете ремонт в новостройке?", "Работаете ли вы с новостройками?"),
    ],
)
def test_top_hit_is_relevant(index: BM25Index, question: str, expected_section: str):
    hits = index.search(question, k=3)
    assert hits, f"нет результатов для {question!r}"
    assert expected_section in [h.chunk.section for h in hits]


@pytest.mark.parametrize(
    "question",
    ["Какой курс биткоина сегодня?", "Сколько стоит кондиционер?", "Сколько стоит ремонт машины?"],
)
def test_irrelevant_question_returns_nothing(index: BM25Index, question: str):
    assert index.search(question, k=3, min_score=1.5) == []


def test_api_search_found(client: TestClient):
    r = client.get("/search", params={"q": "гарантия на сантехнику"})
    assert r.status_code == 200
    body = r.json()
    assert body["found"] is True
    assert "5 лет" in body["results"][0]["text"]


def test_api_search_not_found_gives_hint(client: TestClient):
    r = client.get("/search", params={"q": "погода в Москве"})
    assert r.status_code == 200
    body = r.json()
    assert body["found"] is False
    assert "менеджер" in body["hint"]


def test_api_validates_query(client: TestClient):
    assert client.get("/search", params={"q": "a"}).status_code == 422


def test_reload_requires_token(client: TestClient):
    assert client.post("/reload").status_code == 403


def test_health(client: TestClient):
    r = client.get("/health")
    assert r.status_code == 200 and r.json()["chunks"] > 10
