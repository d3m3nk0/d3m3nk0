'use strict';

/**
 * Вложения в чат в НАСТОЯЩЕМ окне: Ctrl+V картинки, перетаскивание файла,
 * отправка сообщения. Окно ведётся через отладочный порт Electron (CDP),
 * поэтому проверяется не только ядро, но и рендерер, IPC и preload.
 *
 * Нужен рабочий стол: Electron открывает видимое окно. Без графики тест
 * пропускается (D3M3NK0_NO_GUI=1 — пропустить принудительно).
 *
 * Своё D3M3NK0_HOME и своя рабочая папка во временном каталоге: настоящий
 * ~/.d3m3nk0 и проект не трогаются. Модель недоступна (baseUrl 127.0.0.1:9),
 * поэтому ключ и лимит токенов не расходуются — проверяется пузырь сообщения
 * и сообщение об ошибке, а не ответ модели.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'd3m3nk0-window-'));
const HOME = path.join(TMP, 'home');
const WORK = path.join(TMP, 'work');
const PDF = path.join(TMP, 'схема задачи.pdf');

const CHECK_TIMEOUT_MS = 90000; // дольше — что-то зависло, окно всё равно закроем

/* ------------------------------- вспомогательное ------------------------------ */

/**
 * Настоящий PNG без зависимостей: сигнатура, IHDR, IDAT (zlib), IEND.
 * Нужен именно корректный файл — nativeImage иначе не построит превью.
 */
function pngBytes(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 2; // truecolor RGB
  const raw = Buffer.alloc((width * 3 + 1) * height); // фильтр 0 в начале каждой строки
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * (width * 3 + 1) + 1 + x * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Подключение к вкладке по WebSocket + обещания на ответы CDP. */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const waiting = new Map();
    const events = [];
    let nextId = 1;
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && waiting.has(msg.id)) {
        const { resolve: res, reject: rej } = waiting.get(msg.id);
        waiting.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      } else if (msg.method) {
        events.push(msg);
      }
    };
    ws.onerror = (e) => reject(new Error(String(e.message || e)));
    ws.onopen = () =>
      resolve({
        events,
        send(method, params = {}) {
          const id = nextId++;
          return new Promise((res, rej) => {
            waiting.set(id, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close: () => ws.close(),
      });
  });
}

function killApp(child) {
  if (!child || child.exitCode != null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

async function main() {
  // В Node require('electron') — это путь к исполняемому файлу, а не API.
  const electron = require('electron');
  if (typeof electron !== 'string') throw new Error('тест запускается через node, а не через electron');

  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(PDF, '%PDF-1.4\n');
  const png = pngBytes(4, 3, [200, 40, 40]);

  // Заведомо недоступный baseUrl: отправка не тратит ни ключ, ни лимит.
  fs.writeFileSync(
    path.join(HOME, 'config.json'),
    JSON.stringify(
      {
        provider: 'openai',
        model: 'test-model',
        baseUrl: 'http://127.0.0.1:9',
        apiKey: 'test',
        workdir: WORK,
        permissionMode: 'ask',
        responseTimeoutMs: 5000,
        retryDelayMs: 100,
        fallbackModels: [],
      },
      null,
      2
    )
  );

  const port = 9333 + Math.floor(Math.random() * 500);
  const env = { ...process.env, D3M3NK0_HOME: HOME, ELECTRON_ENABLE_LOGGING: '0' };
  delete env.D3M3NK0_SCREENSHOT;
  delete env.D3M3NK0_SMOKE;
  delete env.D3M3NK0_SHOT_PROMPT;

  const child = spawn(electron, ['.', `--remote-debugging-port=${port}`], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let appLog = '';
  child.stdout.on('data', (d) => (appLog += d.toString()));
  child.stderr.on('data', (d) => (appLog += d.toString()));

  let cdp = null;
  const watchdog = setTimeout(() => {
    console.log(`FAIL проверка окна не уложилась в ${CHECK_TIMEOUT_MS / 1000} с`);
    killApp(child);
    process.exit(1);
  }, CHECK_TIMEOUT_MS);

  try {
    let target = null;
    for (let i = 0; i < 80 && !target; i++) {
      await sleep(250);
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
      } catch {
        // окно ещё поднимается
      }
    }
    if (!target) throw new Error(`окно не поднялось за 20 с:\n${appLog.slice(-1200)}`);

    cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');

    const evaluate = async (expression) => {
      const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (res.exceptionDetails) throw new Error(`исключение в окне: ${res.exceptionDetails.exception?.description}`);
      return res.result.value;
    };

    const results = [];
    const check = async (name, fn) => {
      try {
        await fn();
        results.push(true);
        console.log(`ok   ${name}`);
      } catch (e) {
        results.push(false);
        console.log(`FAIL ${name}: ${e.message}`);
      }
    };

    await sleep(900);

    await check('окно загрузилось', async () => {
      assert.strictEqual(await evaluate('document.title'), 'd3m3nk0');
      assert.strictEqual(await evaluate('document.getElementById("input") != null'), true, 'нет поля ввода');
    });

    // 1. Ctrl+V картинки: как настоящий скриншот — File без пути, только байты.
    let pastedFile = '';
    await check('Ctrl+V картинки → чип с превью, файл сохраняется во «Вложения»', async () => {
      const res = await evaluate(`(async () => {
        const bytes = Uint8Array.from(atob(${JSON.stringify(png.toString('base64'))}), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
        document.getElementById('input').dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
        );
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 50));
          if (document.querySelectorAll('#attachments .chip').length) break;
        }
        const chip = document.querySelector('#attachments .chip');
        return {
          chips: document.querySelectorAll('#attachments .chip').length,
          preview: chip ? !!chip.querySelector('img') : false,
          rel: chip ? chip.title : '',
          hidden: document.getElementById('attachments').hidden,
        };
      })()`);
      assert.strictEqual(res.chips, 1, 'чипа нет');
      assert.ok(res.preview, 'у картинки нет превью');
      assert.ok(!res.hidden, 'блок вложений скрыт');
      assert.ok(/^Вложения[\\/]\d{8}-\d{6}-скриншот\.png$/.test(res.rel), `странное имя: ${res.rel}`);
      pastedFile = path.join(WORK, res.rel);
      assert.ok(fs.existsSync(pastedFile), 'файла нет на диске');
      assert.deepStrictEqual(fs.readFileSync(pastedFile), png, 'байты картинки изменились');
    });

    // 2. Перетаскивание настоящего файла с диска: путь есть только у реального файла,
    // поэтому событие отправляем через CDP с files, а не синтетическим DataTransfer.
    await check('перетаскивание файла → подсветка поля и чип «PDF»', async () => {
      const box = await evaluate(`(() => {
        const r = document.getElementById('input').getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      const data = { items: [], files: [PDF], dragOperationsMask: 1 };
      await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: box.x, y: box.y, data });
      await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: box.x, y: box.y, data });
      const highlighted = await evaluate('document.body.classList.contains("dropping")');
      await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: box.x, y: box.y, data });
      await sleep(900);
      const res = await evaluate(`(() => {
        const chips = [...document.querySelectorAll('#attachments .chip')];
        return {
          chips: chips.length,
          rel: chips.length > 1 ? chips[1].title : '',
          icon: chips.length > 1 ? chips[1].querySelector('.chip-icon')?.textContent : null,
          dropping: document.body.classList.contains('dropping'),
        };
      })()`);
      assert.ok(highlighted, 'поле не подсветилось при перетаскивании');
      assert.strictEqual(res.dropping, false, 'подсветка не снялась после drop');
      assert.strictEqual(res.chips, 2, 'второго чипа нет');
      assert.strictEqual(res.icon, 'PDF', 'у PDF не тот значок');
      assert.ok(/^Вложения[\\/]\d{8}-\d{6}-схема задачи\.pdf$/.test(res.rel), `странное имя: ${res.rel}`);
      assert.ok(fs.existsSync(path.join(WORK, res.rel)), 'PDF не скопирован в рабочую папку');
    });

    // 3. Отправка: модель недоступна, но пузырь пользователя и ошибка уже видны.
    await check('отправка: в сообщении оба вложения с подсказками, чипы убраны', async () => {
      await evaluate(`document.getElementById('input').value = 'Проверка вложений'; document.getElementById('send').click();`);
      await sleep(2500);
      const res = await evaluate(`(() => {
        const bubble = document.querySelector('.msg.user');
        return {
          text: bubble ? bubble.textContent : '',
          chips: document.querySelectorAll('#attachments .chip').length,
        };
      })()`);
      assert.ok(/Проверка вложений/.test(res.text), 'текста пользователя нет в пузыре');
      assert.ok(/Вложения:/.test(res.text), 'нет списка вложений');
      assert.ok(/view_image/.test(res.text), 'нет подсказки про view_image');
      assert.ok(/read_pdf/.test(res.text), 'нет подсказки про read_pdf');
      assert.strictEqual(res.chips, 0, 'чипы остались после отправки');
    });

    await check('ошибка модели показана, окно вернулось в рабочее состояние', async () => {
      const res = await evaluate(`(() => ({
        err: [...document.querySelectorAll('.msg.error')].map((e) => e.textContent).join(' | '),
        busy: document.getElementById('send').disabled,
      }))()`);
      assert.ok(/Сеть недоступна|не ответила|Ошибка/i.test(res.err), `нет сообщения об ошибке: ${res.err}`);
      assert.strictEqual(res.busy, false, 'окно осталось занятым');
    });

    await check('счётчик токенов под ответом: вход, выход, кэш', async () => {
      // Переключаем окно на поддельный сервер — настоящая сеть и ключ не нужны.
      const { startFakeLlm, STREAM_CHUNKS } = require('./helpers/fake-llm');
      const fake = await startFakeLlm({ chunkDelayMs: 30 });
      try {
        const switched = await evaluate(`window.d3.setConfig({ baseUrl: ${JSON.stringify(fake.url('stream'))}, model: 'model-ok' })`);
        assert.ok(switched && switched.ok, `окно не переключилось: ${JSON.stringify(switched)}`);
        await sleep(700);

        await evaluate(`document.getElementById('input').value = 'ответь'; document.getElementById('send').click();`);
        // Ждём ответ, а не фиксированные 2,5 с: стриминг может начаться позже.
        let res = null;
        for (let i = 0; i < 40; i++) {
          await sleep(250);
          res = await evaluate(`(() => {
            const answers = [...document.querySelectorAll('#transcript .msg.assistant')];
            const metas = [...document.querySelectorAll('#transcript .msg-meta')];
            return {
              answer: answers.length ? answers[answers.length - 1].textContent : '',
              meta: metas.length ? metas[metas.length - 1].textContent : '',
            };
          })()`);
          if (res.answer) break;
        }
        const diag = JSON.stringify({ requests: fake.requests.length, ...res });
        assert.strictEqual(res.answer, STREAM_CHUNKS.join(''), `ответ модели не отрисован: ${diag}`);
        // Строка расхода — сразу под ответом, а не где-то в конце ленты.
        assert.strictEqual(
          await evaluate(`(() => {
            const a = [...document.querySelectorAll('#transcript .msg.assistant')].pop();
            return a && a.nextElementSibling ? a.nextElementSibling.className : '';
          })()`),
          'msg-meta',
          'строки расхода нет под ответом'
        );
        assert.match(res.meta, /токены: ↑ 1\s200 · ↓ 34 · кэш 900/, `строка расхода: «${res.meta}»`);
      } finally {
        await fake.close();
      }
    });

    await check('в консоли окна нет ошибок (CSP, обработчики)', async () => {
      const errors = cdp.events
        .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
        .map((e) => (e.params.exceptionDetails?.exception?.description || e.params.entry?.text || '').split('\n')[0])
        .filter(Boolean);
      assert.deepStrictEqual(errors, []);
    });

    const failed = results.filter((ok) => !ok).length;
    if (failed) {
      // Снимок окна помогает понять, что было на экране в момент падения.
      try {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        const file = path.join(TMP, 'window.png');
        fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
        console.log(`снимок окна: ${file}`);
      } catch {
        // без снимка отчёт всё равно есть
      }
    }
    console.log(`\n${results.length - failed}/${results.length} проверок окна пройдено`);
    return failed === 0;
  } finally {
    clearTimeout(watchdog);
    cdp?.close();
    killApp(child);
    await sleep(500);
    // Временные файлы убираем: рабочая папка теста никому больше не нужна.
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      // на Windows файл мог остаться заблокированным — не повод падать
    }
  }
}

if (process.env.D3M3NK0_NO_GUI) {
  console.log('пропущено: D3M3NK0_NO_GUI=1 (нужен рабочий стол для окна Electron)');
  process.exit(0);
}

main().then(
  (ok) => process.exit(ok ? 0 : 1),
  (e) => {
    console.log(`FAIL проверка окна: ${e.message}`);
    process.exit(2);
  }
);
