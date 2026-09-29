#!/usr/bin/env python3
"""Заглушки Gemini API и Telegram Bot API для сквозного теста без реальных ключей.

Позволяет проверить всю цепочку «виджет → nginx → n8n → агент → инструменты →
под-процесс заявки → Telegram», не расходуя лимит бесплатного тарифа Gemini.
Сценарий заглушки LLM детерминирован:
  * сообщение с номером телефона → вызов инструмента create_lead;
  * любое другое сообщение       → вызов инструмента search_knowledge_base;
  * получен результат инструмента → текстовый ответ на его основе.
Если существует файл /tmp/mock429, заглушка отвечает 429 RESOURCE_EXHAUSTED,
что позволяет проверить резервный ответ при исчерпании лимита.

Запуск:  python tests/e2e/mock_services.py 9911
В .env:  GEMINI_API_HOST=http://<хост>:9911  TELEGRAM_API_BASE_URL=http://<хост>:9911
"""

from __future__ import annotations

import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PHONE_RE = re.compile(r"\d{3}.*\d{2}.*\d{2}")


def gemini_reply(req: dict) -> dict:
    contents = req.get("contents", [])
    last = contents[-1] if contents else {}
    tool_results = [p["functionResponse"] for p in last.get("parts", []) if "functionResponse" in p]

    if tool_results:
        name = tool_results[0]["name"]
        payload = json.dumps(tool_results[0].get("response", {}), ensure_ascii=False)
        print(f"[llm] результат инструмента {name}: {payload[:200]}", flush=True)
        if name == "create_lead":
            m = re.search(r"L-\d{6}-\d+", payload)
            text = (f"Спасибо! Заявка {m.group(0)} создана, менеджер позвонит в рабочее время."
                    if m else "Не удалось создать заявку, проверьте номер телефона.")
        else:
            m = re.search(r"от [\d  ]+ рублей за м²", payload)
            text = (f"Стоимость — {m.group(0)}. Точная цена определяется после бесплатного замера."
                    if m else "Уточню этот вопрос у менеджера. Оставьте, пожалуйста, телефон.")
        parts = [{"text": text}]
    else:
        user_text = " ".join(p.get("text", "") for p in last.get("parts", []))
        print(f"[llm] сообщение: {user_text[:120]}", flush=True)
        if PHONE_RE.search(user_text):
            call = {"name": "create_lead",
                    "args": {"name": "Тестовый клиент", "phone": PHONE_RE.search(user_text).group(0),
                             "request": "сквозной тест"}}
        else:
            call = {"name": "search_knowledge_base", "args": {"query": user_text[:200]}}
        parts = [{"functionCall": call}]

    return {
        "candidates": [{"content": {"role": "model", "parts": parts}, "finishReason": "STOP", "index": 0}],
        "usageMetadata": {"promptTokenCount": 1, "candidatesTokenCount": 1, "totalTokenCount": 2},
    }


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: dict, content_type: str = "application/json") -> None:
        data = json.dumps(body, ensure_ascii=False).encode()
        if content_type == "text/event-stream":
            data = b"data: " + data + b"\n\n"
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        if "generatecontent" in self.path.lower():
            if os.path.exists("/tmp/mock429"):
                self._send(429, {"error": {"code": 429, "message": "Resource has been exhausted (e.g. check quota).",
                                           "status": "RESOURCE_EXHAUSTED"}})
            elif "stream" in self.path.lower():
                self._send(200, gemini_reply(body), "text/event-stream")
            else:
                self._send(200, gemini_reply(body))
        elif self.path.endswith("/sendMessage"):
            print(f"[telegram] chat={body.get('chat_id')}\n{body.get('text')}", flush=True)
            self._send(200, {"ok": True, "result": {"message_id": 1, "date": 0, "chat": {"id": body.get("chat_id")},
                                                     "text": body.get("text")}})
        else:
            self._send(404, {"error": "not found"})

    def log_message(self, *args) -> None:
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9911
    print(f"Заглушки Gemini и Telegram слушают порт {port}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
