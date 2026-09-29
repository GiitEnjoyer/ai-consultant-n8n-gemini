#!/usr/bin/env python3
"""Регрессионная проверка качества ответов ИИ-консультанта.

Отправляет контрольные вопросы в webhook n8n и проверяет, что ответ содержит
ожидаемые факты из базы знаний и не содержит запрещённых фрагментов
(выдуманных цен, утечки системного промпта). Запускается после любого
изменения промпта, модели или базы знаний.

Пример:
    python scripts/eval_dialogs.py --url http://localhost:8080/api/chat
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

DEFAULT_CASES = Path(__file__).with_name("eval_cases.json")


def ask(url: str, message: str, timeout: float) -> str:
    payload = json.dumps({"sessionId": f"eval-{uuid.uuid4()}", "message": message}).encode()
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8")).get("reply", "")


def check(reply: str, case: dict) -> list[str]:
    low = reply.lower()
    problems = []
    if case["expect_any"] and not any(e.lower() in low for e in case["expect_any"]):
        problems.append(f"нет ни одного из ожидаемых фрагментов {case['expect_any']}")
    for f in case.get("forbid", []):
        if f.lower() in low:
            problems.append(f"найден запрещённый фрагмент {f!r}")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default="http://localhost:8080/api/chat")
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    parser.add_argument("--timeout", type=float, default=60)
    parser.add_argument(
        "--delay", type=float, default=7, help="пауза между запросами, чтобы не превысить RPM бесплатного тарифа"
    )
    args = parser.parse_args()

    cases = json.loads(args.cases.read_text(encoding="utf-8"))
    failed = 0
    for i, case in enumerate(cases, 1):
        started = time.monotonic()
        try:
            reply = ask(args.url, case["message"], args.timeout)
            problems = check(reply, case)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            reply, problems = "", [f"ошибка запроса: {exc}"]
        elapsed = time.monotonic() - started
        status = "OK  " if not problems else "FAIL"
        failed += bool(problems)
        print(f"[{status}] {i}/{len(cases)} {case['name']} ({elapsed:.1f} с)")
        print(f"       Вопрос: {case['message']}")
        print(f"       Ответ:  {reply[:300]}")
        for p in problems:
            print(f"       ! {p}")
        if i < len(cases):
            time.sleep(args.delay)

    print(f"\nИтого: {len(cases) - failed} из {len(cases)} проверок пройдено")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
