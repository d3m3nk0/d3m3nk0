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
function pngBytes(width, height, rgb) {
  // rgb — [r, g, b] на всю картинку или функция (x, y) => [r, g, b].
  const colorAt = typeof rgb === 'function' ? rgb : () => rgb;
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
      const [r, g, b] = colorAt(x, y);
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

    // Кроп view_image — настоящий nativeImage в главном процессе: картинка 40×30,
    // левая половина красная, правая синяя; модель просит правую половину.
    await check('view_image region: nativeImage вырезает фрагмент, увеличивает, за краем — ошибка', async () => {
      fs.writeFileSync(path.join(WORK, 'crop.png'), pngBytes(40, 30, (x) => (x < 20 ? [220, 0, 0] : [0, 0, 220])));
      const { startFakeLlm } = require('./helpers/fake-llm');
      const fake = await startFakeLlm({ chunkDelayMs: 20 });
      try {
        const switched = await evaluate(`window.d3.setConfig({ baseUrl: ${JSON.stringify(fake.url('stream'))}, model: 'model-ok' })`);
        assert.ok(switched && switched.ok, `окно не переключилось: ${JSON.stringify(switched)}`);
        await sleep(700);

        const ask = async (text) => {
          const before = await evaluate(`document.querySelectorAll('#transcript .tool').length`);
          await evaluate(`document.getElementById('input').value = ${JSON.stringify(text)}; document.getElementById('send').click();`);
          for (let i = 0; i < 40; i++) {
            await sleep(250);
            const st = await evaluate(`({ n: document.querySelectorAll('#transcript .tool').length, busy: document.getElementById('send').disabled })`);
            if (st.n > before && !st.busy) break;
          }
        };

        // 1) Правая половина: 20×30 → увеличение ×3 → 60×90, и в ней только синий.
        await ask('обрежь картинку');
        const res = await evaluate(`(async () => {
          const card = [...document.querySelectorAll('#transcript .tool')].pop();
          const img = card && card.querySelector('.tool-image');
          if (!img) return { status: card ? card.querySelector('.tool-status').textContent : 'нет карточки', out: card ? card.querySelector('.tool-output').textContent : '' };
          if (!img.complete) await new Promise((r) => (img.onload = r));
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          const g = c.getContext('2d');
          g.drawImage(img, 0, 0);
          const px = (x, y) => [...g.getImageData(x, y, 1, 1).data.slice(0, 3)];
          return {
            status: card.querySelector('.tool-status').textContent,
            out: card.querySelector('.tool-output').textContent,
            w: img.naturalWidth,
            h: img.naturalHeight,
            corners: [px(1, 1), px(img.naturalWidth - 2, 1), px(1, img.naturalHeight - 2), px(img.naturalWidth - 2, img.naturalHeight - 2)],
          };
        })()`);
        assert.strictEqual(res.status, 'готово', `инструмент: ${res.status} — ${res.out}`);
        assert.deepStrictEqual([res.w, res.h], [60, 90], 'размер вырезки не 60×90');
        for (const [r, g, b] of res.corners) assert.ok(b > 150 && r < 60 && g < 60, `в вырезке не только синий: ${JSON.stringify(res.corners)}`);
        assert.ok(/фрагмент x=20, y=0, 20×30 из картинки 40×30/.test(res.out) && /увеличен до 60×90/.test(res.out), res.out);
        const sent = fake.requests.find((r) => r.images.length);
        assert.ok(sent, 'модели картинка не ушла');
        const png = Buffer.from(sent.images[0].split(',')[1], 'base64');
        assert.deepStrictEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [60, 90], 'модели ушла не вырезка');

        // 2) Region за краем: ошибка инструмента с настоящим размером картинки.
        await ask('обрежь за краем');
        const bad = await evaluate(`(() => {
          const card = [...document.querySelectorAll('#transcript .tool')].pop();
          return { status: card.querySelector('.tool-status').textContent, out: card.querySelector('.tool-output').textContent };
        })()`);
        assert.strictEqual(bad.status, 'ошибка', `region за краем не дал ошибку: ${bad.out}`);
        assert.ok(/она 40×30 px/.test(bad.out), bad.out);
      } finally {
        await fake.close();
      }
    });

    // Переименование сессии в списке. Пункт «Переименовать…» — в нативном меню
    // правого клика, CDP его не нажмёт; поле открываем той же startRename(), что и меню.
    await check('переименование в списке: Enter сохраняет в журнал, пустое — нельзя, Esc — отмена', async () => {
      const sessionsDir = path.join(HOME, 'sessions');
      const open = async () =>
        evaluate(`(async () => {
          const list = await window.d3.listSessions();
          const s = list[0];
          const btn = document.querySelector('#sessions .session[data-id="' + s.id + '"]');
          startRename(btn, s);
          return { id: s.id, field: !!document.querySelector('#sessions .session-rename'), focused: document.activeElement?.className };
        })()`);
      const key = (k, value) =>
        evaluate(`(() => {
          const f = document.querySelector('#sessions .session-rename');
          if (${JSON.stringify(value)} !== null) f.value = ${JSON.stringify(value)};
          f.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true }));
        })()`);

      // 1) Ввести имя и Enter.
      const first = await open();
      assert.ok(first.field && first.focused === 'session-rename', `поле не открылось: ${JSON.stringify(first)}`);
      await key('Enter', 'Окно: моё имя');
      await sleep(500);
      const after = await evaluate(`(() => {
        const b = document.querySelector('#sessions .session[data-id="${first.id}"]');
        return { label: b ? b.textContent : null, tip: b ? b.title : '', field: !!document.querySelector('#sessions .session-rename') };
      })()`);
      assert.strictEqual(after.label, 'Окно: моё имя', `в списке: ${after.label}`);
      assert.ok(!after.field, 'поле не закрылось');
      assert.ok(after.tip.includes(first.id), 'при наведении нет id');
      const journal = fs.readFileSync(path.join(sessionsDir, `${first.id}.jsonl`), 'utf8');
      assert.ok(journal.includes('"name":"Окно: моё имя","source":"manual"'), 'имя не записано в журнал');

      // 2) Пустое имя: поле остаётся и подсвечено, журнал не меняется; Esc — отмена.
      await open();
      await key('Enter', '   ');
      await sleep(300);
      const empty = await evaluate(`(() => {
        const f = document.querySelector('#sessions .session-rename');
        return { field: !!f, invalid: f ? f.classList.contains('invalid') : false };
      })()`);
      assert.ok(empty.field && empty.invalid, `пустое имя: ${JSON.stringify(empty)}`);
      await key('Escape', null);
      await sleep(400);
      const label = await evaluate(`document.querySelector('#sessions .session[data-id="${first.id}"]')?.textContent`);
      assert.strictEqual(label, 'Окно: моё имя', 'после Esc имя изменилось');
      assert.strictEqual(fs.readFileSync(path.join(sessionsDir, `${first.id}.jsonl`), 'utf8'), journal, 'журнал изменился от пустого имени или Esc');
    });

    // Профили провайдеров (Пункт 11): форма → выбор в списке → следующий запрос уходит
    // на новый сервер без заголовка ключа, счётчик токенов виден; недоступный профиль
    // не включается, прежний остаётся. Ключ профиля в окно не попадает.
    await check('профили: добавить и выбрать в окне, запрос без ключа, счётчик; недоступный — не включается', async () => {
      const { startFakeLlm } = require('./helpers/fake-llm');
      const local = await startFakeLlm({ chunkDelayMs: 20, models: ['local-model'] });
      const closedPort = await new Promise((resolve) => {
        const srv = require('node:net').createServer().listen(0, '127.0.0.1', () => {
          const { port } = srv.address();
          srv.close(() => resolve(port));
        });
      });
      const waitStatus = async () => {
        for (let i = 0; i < 40; i++) {
          await sleep(150);
          const st = await evaluate(`({ text: document.getElementById('prov-status').textContent, cls: document.getElementById('prov-status').className, disabled: document.getElementById('prov-active').disabled })`);
          if (!st.disabled && !/Проверяю|Переключаю/.test(st.text)) return st;
        }
        throw new Error('статус профиля не обновился');
      };
      const addProfile = async (p) =>
        evaluate(`(async () => {
          document.getElementById('prov-add').open = true;
          document.getElementById('prov-name').value = ${JSON.stringify(p.name)};
          document.getElementById('prov-provider').value = 'openai';
          document.getElementById('prov-baseurl').value = ${JSON.stringify(p.baseUrl)};
          document.getElementById('prov-model').value = ${JSON.stringify(p.model)};
          document.getElementById('prov-key').value = ${JSON.stringify(p.apiKey || '')};
          document.getElementById('prov-add-btn').click();
          await new Promise((r) => setTimeout(r, 400));
          const opt = [...document.getElementById('prov-active').options].find((o) => o.textContent.startsWith(${JSON.stringify(p.name)}));
          return { id: opt ? opt.value : null, err: document.getElementById('prov-error').hidden ? '' : document.getElementById('prov-error').textContent };
        })()`);
      const choose = async (id) =>
        evaluate(`(() => { const s = document.getElementById('prov-active'); s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event('change')); })()`);
      try {
        await evaluate(`openSettings('profiles')`);
        await sleep(300);

        // 1) Добавить локальный профиль без ключа и выбрать его.
        const added = await addProfile({ name: 'Локальная модель', baseUrl: local.url('stream'), model: 'local-model' });
        assert.ok(added.id && !added.err, `профиль не добавлен: ${JSON.stringify(added)}`);
        await choose(added.id);
        const st = await waitStatus();
        assert.ok(/prov-ok/.test(st.cls) && /Локальная модель/.test(st.text), `профиль не включился: ${st.text}`);
        assert.ok((await evaluate(`document.getElementById('model-badge').textContent`)).startsWith('Локальная модель · local-model'), 'шапка не показывает профиль');

        // 2) Следующий запрос — на новый сервер, без Authorization; счётчик токенов виден.
        await evaluate(`document.getElementById('settings').close()`);
        await evaluate(`document.getElementById('input').value = 'ответь через профиль'; document.getElementById('send').click();`);
        let meta = '';
        for (let i = 0; i < 40 && !meta; i++) {
          await sleep(250);
          meta = await evaluate(`(() => { const m = [...document.querySelectorAll('#transcript .msg-meta')].pop(); return m && !document.getElementById('send').disabled ? m.textContent : ''; })()`);
        }
        assert.strictEqual(local.requests.length, 1, `запросов к профилю: ${local.requests.length}`);
        assert.deepStrictEqual([local.requests[0].model, local.requests[0].authorization], ['local-model', null], 'ушёл заголовок ключа или не та модель');
        assert.match(meta, /токены: ↑ 1\s200 · ↓ 34 · кэш 900/, `строка расхода: «${meta}»`);

        // 3) Недоступный профиль (с ключом): не включается, прежний остаётся; ключ не в окне.
        await evaluate(`openSettings('profiles')`);
        await sleep(300);
        const dead = await addProfile({ name: 'Не запущен', baseUrl: `http://127.0.0.1:${closedPort}/v1`, model: 'x', apiKey: 'sk-window-secret' });
        assert.ok(dead.id, 'второй профиль не добавлен');
        await choose(dead.id);
        const st2 = await waitStatus();
        assert.ok(/prov-err/.test(st2.cls) && /Профиль не включён: Сервер не отвечает/.test(st2.text), `нет понятной ошибки: ${st2.text}`);
        assert.strictEqual(await evaluate(`document.getElementById('prov-active').value`), added.id, 'в списке остался недоступный профиль');
        assert.ok((await evaluate(`document.getElementById('model-badge').textContent`)).startsWith('Локальная модель'), 'шапка сменилась');
        const saved = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
        assert.strictEqual(saved.activeProfile, added.id, 'активным стал недоступный профиль');
        assert.ok(JSON.stringify(saved.profiles).includes('sk-window-secret'), 'ключ не сохранён в config.json');
        const inWindow = await evaluate(`(async () => document.body.innerHTML.includes('sk-window-secret') || JSON.stringify(await window.d3.getConfig()).includes('sk-window-secret'))()`);
        assert.strictEqual(inWindow, false, 'ключ профиля попал в окно');
        await evaluate(`document.getElementById('settings').close()`);
      } finally {
        await local.close();
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
