/**
 * Встраиваемый виджет онлайн-консультанта.
 *
 * Подключение на любом сайте одной строкой:
 *   <script src="/widget/chat-widget.js"
 *           data-endpoint="/api/chat"
 *           data-title="Консультант «Кварта»"
 *           data-greeting="Здравствуйте! Помогу рассчитать ремонт."
 *           defer></script>
 *
 * Виджет не имеет зависимостей, стили изолированы префиксом .aic-.
 * Протокол: POST {sessionId, message, page} -> {reply, sessionId}.
 */
(function () {
  "use strict";

  const script = document.currentScript;
  const cfg = {
    endpoint: script?.dataset.endpoint || "/api/chat",
    title: script?.dataset.title || "Онлайн-консультант",
    greeting:
      script?.dataset.greeting ||
      "Здравствуйте! Задайте вопрос — отвечу сразу, а при необходимости передам менеджеру.",
    quickReplies: (script?.dataset.quick || "Сколько стоит ремонт?|Какие сроки?|Какая гарантия?")
      .split("|")
      .filter(Boolean),
    timeoutMs: Number(script?.dataset.timeout || 45000),
  };

  const STORAGE_KEY = "aic_session_id";
  const MAX_LEN = 1000;

  function getSessionId() {
    let id = null;
    try {
      id = localStorage.getItem(STORAGE_KEY);
    } catch (_) {
      /* localStorage недоступен (приватный режим) — сессия живёт до перезагрузки */
    }
    if (!id || !/^[a-zA-Z0-9-]{8,64}$/.test(id)) {
      id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
      try {
        localStorage.setItem(STORAGE_KEY, id);
      } catch (_) {}
    }
    return id;
  }

  const CSS = `
  .aic-launcher{position:fixed;right:20px;bottom:20px;width:60px;height:60px;border-radius:50%;border:0;
    background:#1f6feb;color:#fff;font-size:26px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);z-index:2147483000}
  .aic-panel{position:fixed;right:20px;bottom:92px;width:360px;max-width:calc(100vw - 32px);height:520px;
    max-height:calc(100vh - 120px);background:#fff;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.25);
    display:none;flex-direction:column;overflow:hidden;z-index:2147483000;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1b1f24}
  .aic-panel.aic-open{display:flex}
  .aic-head{background:#1f6feb;color:#fff;padding:12px 16px;display:flex;justify-content:space-between;align-items:center}
  .aic-head b{font-size:15px}.aic-head small{display:block;opacity:.85}
  .aic-close{background:none;border:0;color:#fff;font-size:22px;cursor:pointer;line-height:1}
  .aic-log{flex:1;overflow-y:auto;padding:14px;background:#f6f8fa;display:flex;flex-direction:column;gap:8px}
  .aic-msg{max-width:85%;padding:9px 12px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word}
  .aic-bot{background:#fff;border:1px solid #e3e6ea;align-self:flex-start;border-bottom-left-radius:4px}
  .aic-user{background:#1f6feb;color:#fff;align-self:flex-end;border-bottom-right-radius:4px}
  .aic-err{background:#fff4f4;border:1px solid #f1c0c0;color:#8a1f1f;align-self:flex-start}
  .aic-typing{align-self:flex-start;color:#6a737d;font-style:italic;padding:4px 2px}
  .aic-quick{display:flex;flex-wrap:wrap;gap:6px;padding:0 14px 10px;background:#f6f8fa}
  .aic-quick button{border:1px solid #1f6feb;color:#1f6feb;background:#fff;border-radius:14px;padding:4px 10px;cursor:pointer;font:inherit;font-size:13px}
  .aic-form{display:flex;border-top:1px solid #e3e6ea}
  .aic-form textarea{flex:1;border:0;resize:none;padding:12px;font:inherit;outline:none;height:48px}
  .aic-form button{border:0;background:#fff;color:#1f6feb;font-weight:600;padding:0 16px;cursor:pointer}
  .aic-form button:disabled{color:#9aa4ae;cursor:default}
  .aic-note{font-size:11px;color:#6a737d;padding:4px 12px 8px;background:#fff}
  `;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text; // только textContent — защита от XSS
    return node;
  }

  function mount() {
    const style = el("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    const launcher = el("button", "aic-launcher", "💬");
    launcher.setAttribute("aria-label", "Открыть чат с консультантом");

    const panel = el("section", "aic-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", cfg.title);

    const head = el("div", "aic-head");
    const headText = el("div");
    headText.append(el("b", "", cfg.title), el("small", "", "Обычно отвечает за несколько секунд"));
    const close = el("button", "aic-close", "×");
    close.setAttribute("aria-label", "Закрыть чат");
    head.append(headText, close);

    const log = el("div", "aic-log");
    log.setAttribute("aria-live", "polite");
    const quick = el("div", "aic-quick");
    const form = el("form", "aic-form");
    const input = el("textarea");
    input.placeholder = "Напишите вопрос…";
    input.maxLength = MAX_LEN;
    const send = el("button", "", "Отправить");
    send.type = "submit";
    form.append(input, send);
    const note = el(
      "div",
      "aic-note",
      "Оставляя контакты в чате, вы соглашаетесь на обработку персональных данных."
    );

    panel.append(head, log, quick, form, note);
    document.body.append(launcher, panel);

    const sessionId = getSessionId();
    let busy = false;

    function addMessage(text, kind) {
      const msg = el("div", `aic-msg aic-${kind}`, text);
      log.appendChild(msg);
      log.scrollTop = log.scrollHeight;
      return msg;
    }

    function renderQuick() {
      quick.replaceChildren();
      cfg.quickReplies.forEach((q) => {
        const b = el("button", "", q);
        b.type = "button";
        b.addEventListener("click", () => ask(q));
        quick.appendChild(b);
      });
    }

    async function ask(text) {
      const message = text.trim().slice(0, MAX_LEN);
      if (!message || busy) return;
      busy = true;
      send.disabled = true;
      quick.replaceChildren();
      addMessage(message, "user");
      input.value = "";
      const typing = el("div", "aic-typing", "Консультант печатает…");
      log.appendChild(typing);
      log.scrollTop = log.scrollHeight;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      try {
        const res = await fetch(cfg.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, message, page: location.pathname }),
          signal: controller.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 429) throw new Error("Слишком много сообщений. Подождите минуту и повторите.");
        if (!res.ok || !data.reply) throw new Error(data.error || "Сервис временно недоступен.");
        addMessage(data.reply, "bot");
      } catch (err) {
        const text =
          err.name === "AbortError"
            ? "Ответ занимает больше времени, чем обычно. Попробуйте ещё раз или позвоните нам."
            : err.message;
        addMessage(text, "err");
      } finally {
        clearTimeout(timer);
        typing.remove();
        busy = false;
        send.disabled = false;
        input.focus();
      }
    }

    function toggle(open) {
      panel.classList.toggle("aic-open", open);
      if (open && !log.childElementCount) {
        addMessage(cfg.greeting, "bot");
        renderQuick();
      }
      if (open) input.focus();
    }

    launcher.addEventListener("click", () => toggle(!panel.classList.contains("aic-open")));
    close.addEventListener("click", () => toggle(false));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      ask(input.value);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        ask(input.value);
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
