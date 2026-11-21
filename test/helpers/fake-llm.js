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
 *   - для SSE по тексту последнего сообщения пользователя:
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
 */
function startFakeLlm(opts = {}) {
  const chunkDelayMs = opts.chunkDelayMs ?? 300;
  const slowChunks = opts.slowChunks ?? 60;
  const slowDelayMs = opts.slowDelayMs ?? 300;
  const cutAfter = opts.cutAfter ?? 3;
  const requests = [];

  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const payload = JSON.parse(body || '{}');
    const mode = req.url.split('/')[1];
    requests.push({ mode, stream: !!payload.stream, text: lastUserText(payload) });

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

    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const text = lastUserText(payload);
    // Клиент мог уйти (Стоп) — дальше не пишем.
    const alive = () => !res.destroyed && !res.writableEnded;

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

module.exports = { startFakeLlm, STREAM_CHUNKS, WHOLE_TEXT };
