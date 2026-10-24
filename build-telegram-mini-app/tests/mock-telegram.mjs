// Локальный mock Telegram Bot API для тестов (TELEGRAM_API_BASE).
// Запуск: node tests/mock-telegram.mjs [port]
//   POST /bot<token>/<method>  → { ok: true, result: ... }
//   GET  /__calls              → список вызовов (для проверок)
//   POST /__reset              → очистить журнал
import http from "node:http";

const PORT = Number(process.argv[2] ?? process.env.MOCK_TG_PORT ?? 3333);
let calls = [];

const INVOICE_URL = "https://t.me/$mock-invoice-link";

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

  if (req.method === "GET" && url.pathname === "/__calls") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(calls));
    return;
  }
  if (req.method === "POST" && url.pathname === "/__reset") {
    calls = [];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const m = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(url.pathname);
  if (!m) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, description: "not found" }));
    return;
  }

  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = { raw };
    }
    const method = m[2];
    calls.push({ method, body });

    const result = method === "createInvoiceLink" ? INVOICE_URL : true;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, result }));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock telegram api on http://127.0.0.1:${PORT}`);
});
