'use strict';

/**
 * Поддельный OpenAI-совместимый сервер для регрессионных тестов.
 * Слушает порт 0 (ОС выдаёт свободный), поэтому параллельные запуски не конфликтуют.
 *
 * Режим выбирается так:
 *   - по пути baseUrl: http://127.0.0.1:<port>/<path>/v1
 *       /nostream/v1  — запрос со stream: true получает 400 «stream is not supported»,
 *                       запрос без stream — обычный JSON
 *       /json/v1      — stream: true молча игнорируется, ответ — обычный JSON
 *       /stream/v1    — SSE (по умолчанию)
 *   - для SSE:
 *       последнее сообщение — результат инструмента (role: tool) — AFTER_TOOL_TEXT
 *     иначе по тексту последнего сообщения пользователя:
 *       содержит «запиши» — вызов write_file (требует подтверждения в режиме ask)
 *       содержит «посмотри» — вызов view_image для pic.png
 *       содержит «жди»    — пауза headerDelayMs до заголовков, потом обычный ответ
 *       содержит «долго»  — длинный поток (slowChunks кусков), для «Стоп»
 *       содержит «оборви» — несколько кусков и обрыв соединения
 *       иначе             — короткий ответ из STREAM_CHUNKS
 *
 * Паузы между кусками щедрые (сотни мс) и задаются параметрами, чтобы
 * проверки «пришло несколькими кусками в разные моменты» не флаковали.
 */

const http = require('node:http');

const STREAM_CHUNKS = ['Первый ', 'кусок, ', 'второй ', 'кусок, ', 'третий кусок.'];
const WHOLE_TEXT = 'Ответ целиком без стриминга.';
const AFTER_TOOL_TEXT = 'Продолжаю после инструмента.';
const VIEW_CALL = { name: 'view_image', arguments: JSON.stringify({ path: 'pic.png' }) };
const WRITE_CALL = { name: 'write_file', arguments: JSON.stringify({ path: 'denied.txt', content: 'не должно появиться' }) };

const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
const delta = (content) => sse({ choices: [{ index: 0, delta: { content } }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lastUserText(payload) {
  const users = (payload.messages || []).filter((m) => m.role === 'user');
  const last = users[users.length - 1];
  return typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content || '');
}

/**
 * @param {object} [opts]
 * @param {number} [opts.chunkDelayMs=300] пауза между кусками обычного ответа
 * @param {number} [opts.slowChunks=60]    сколько кусков в длинном ответе
 * @param {number} [opts.slowDelayMs=300]  пауза между кусками длинного ответа
 * @param {number} [opts.cutAfter=3]       сколько кусков до обрыва соединения
 * @param {number} [opts.headerDelayMs=1500] пауза до заголовков в режиме «жди»
 */
function startFakeLlm(opts = {}) {
  const chunkDelayMs = opts.chunkDelayMs ?? 300;
  const slowChunks = opts.slowChunks ?? 60;
  const slowDelayMs = opts.slowDelayMs ?? 300;
  const cutAfter = opts.cutAfter ?? 3;
  const headerDelayMs = opts.headerDelayMs ?? 1500;
  const requests = [];

  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const payload = JSON.parse(body || '{}');
    const mode = req.url.split('/')[1];
    // Для проверок картинок: порядок ролей и data-URL всех image_url в запросе.
    const msgsIn = payload.messages || [];
    const images = msgsIn.flatMap((m) => (Array.isArray(m.content) ? m.content : []).filter((c) => c.type === 'image_url').map((c) => c.image_url.url));
    requests.push({ mode, model: payload.model, stream: !!payload.stream, text: lastUserText(payload), roles: msgsIn.map((m) => m.role), images });

    // Поведение по имени модели (тесты устойчивости):
    //   model-silent — не отвечает вовсе, пока клиент не оборвёт соединение;
    //   model-429    — всегда «перегружено».
    if (payload.model === 'model-silent') {
      req.on('close', () => res.destroy());
      return;
    }
    if (payload.model === 'model-429') {
      res.writeHead(429, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Too Many Requests' } }));
    }

    const whole = () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: WHOLE_TEXT }, finish_reason: 'stop' }] }));
    };

    if (mode === 'nostream') {
      if (payload.stream) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'stream is not supported by this model' } }));
      }
      return whole();
    }
    if (mode === 'json') return whole();

    const text = lastUserText(payload);
    // «жди» — сервер молчит до заголовков: «Стоп» попадает в ожидание fetch().
    if (/жди/.test(text)) await sleep(headerDelayMs);
    if (res.destroyed) return;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // Клиент мог уйти (Стоп) — дальше не пишем.
    const alive = () => !res.destroyed && !res.writableEnded;
    const msgs = payload.messages || [];
    const done = () => {
      res.write('data: [DONE]\n\n');
      res.end();
    };

    // Защита от метаний: «упрямо» — всегда вызывать падающий инструмент,
    // «кругами» — всегда один и тот же успешный вызов (даже после результата).
    if (/упрямо|кругами/.test(text)) {
      const fn = /упрямо/.test(text)
        ? { name: 'view_image', arguments: JSON.stringify({ path: 'нет-такой.png' }) }
        : { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) };
      const id = 'call_loop_' + msgs.length;
      res.write(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: fn }] } }] }));
      res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
      return done();
    }
    // После результата инструмента (в том числе отказа) модель продолжает ход текстом.
    if (msgs[msgs.length - 1]?.role === 'tool') {
      res.write(delta(AFTER_TOOL_TEXT));
      return done();
    }
    if (/посмотри/.test(text)) {
      res.write(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_view', type: 'function', function: VIEW_CALL }] } }] }));
      res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
      return done();
    }
    if (/запиши/.test(text)) {
      res.write(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_write', type: 'function', function: WRITE_CALL }] } }] }));
      res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
      return done();
    }
    if (/оборви/.test(text)) {
      for (let i = 0; i < cutAfter && alive(); i++) {
        res.write(delta(`часть${i + 1} `));
        await sleep(chunkDelayMs);
      }
      return res.socket.destroy();
    }
    if (/долго/.test(text)) {
      for (let i = 0; i < slowChunks && alive(); i++) {
        res.write(delta(`слово${i + 1} `));
        await sleep(slowDelayMs);
      }
    } else {
      for (const c of STREAM_CHUNKS) {
        if (!alive()) break;
        res.write(delta(c));
        await sleep(chunkDelayMs);
      }
    }
    if (alive()) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        url: (mode = 'stream') => `http://127.0.0.1:${port}/${mode}/v1`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { startFakeLlm, STREAM_CHUNKS, WHOLE_TEXT, AFTER_TOOL_TEXT };
