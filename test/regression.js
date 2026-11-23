'use strict';

/**
 * Регрессионные тесты: стриминг, «Стоп», Ctrl+C, сжатие контекста.
 * Модель не нужна: отвечает поддельный сервер (test/helpers/fake-llm.js).
 * Запуск: node test/regression.js
 *
 * Изоляция: всё живёт во временных папках. D3M3NK0_HOME (папка config.json и
 * sessions/) выставляется ДО загрузки ядра, поэтому настоящие
 * ~/.d3m3nk0/config.json и ~/.d3m3nk0/sessions не читаются и не пишутся.
 * Каждый запуск CLI получает свою папку — так его журнал легко найти.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'd3m3nk0-regress-'));
const HOME = path.join(TMP_ROOT, 'home');
fs.mkdirSync(HOME, { recursive: true });
process.env.D3M3NK0_HOME = HOME; // до require ядра: config.js читает его при загрузке

const { startFakeLlm, STREAM_CHUNKS, WHOLE_TEXT, AFTER_TOOL_TEXT } = require('./helpers/fake-llm');
const { loadConfig } = require('../src/core/config');
const { Session } = require('../src/core/session');
const { Agent, buildSystemPrompt, loadProjectRules, RULES_MAX_CHARS } = require('../src/core/agent');
const { estimateTokens, estimateMessagesTokens } = require('../src/core/providers');
const { truncateToolResult, prepareForRequest, toolSchemaTokens } = require('../src/core/context');

const CTRL_C = '\u0003';
const CLI_TIMEOUT_MS = 20000;
let failed = false;

async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message}`);
    failed = true;
  }
}

/* -------------------------------- окружение -------------------------------- */

// Живой MCP-процесс, как REA в настоящем конфиге: без него зависший
// rl.question() не держит Node, и ошибки с Ctrl+C в покое не видно.
const FAKE_MCP = { fake: { command: process.execPath, args: [path.join(__dirname, 'helpers', 'fake-mcp.js')] } };

/** Отдельная папка настроек для одного запуска CLI: модель — fake-сервер, MCP — fake-mcp. */
function makeHome(name, baseUrl, extra = {}) {
  const home = path.join(TMP_ROOT, name);
  const work = path.join(home, 'work');
  fs.mkdirSync(work, { recursive: true });
  const config = { provider: 'openai', model: 'fake', baseUrl, apiKey: 'test', workdir: work, mcpServers: FAKE_MCP, ...extra };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config, null, 2));
  return home;
}

/** Все сообщения из журналов сессий папки home. */
function journal(home) {
  const dir = path.join(home, 'sessions');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) =>
      fs
        .readFileSync(path.join(dir, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l).entry.message)
    );
}
const assistantTexts = (messages) =>
  messages.filter((m) => m.role === 'assistant').map((m) => m.blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''));

/**
 * Запустить cli.js в эмулированном терминале по сценарию нажатий.
 * Возвращает записи CLI с метками времени, склеенный вывод и код выхода.
 */
function runCli(home, steps, timeoutMs = CLI_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'helpers', 'cli-tty.js'), JSON.stringify(steps)], {
      env: { ...process.env, D3M3NK0_HOME: home },
    });
    let raw = '';
    child.stderr.on('data', (d) => (raw += d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const events = raw
        .split('\n')
        .filter((l) => l.startsWith('@@'))
        .map((l) => JSON.parse(l.slice(2)));
      const writes = events.filter((e) => 'out' in e);
      const out = writes.map((e) => e.out).join('').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
      const exit = events.find((e) => 'exit' in e)?.exit ?? code;
      resolve({ writes, out, exit, timedOut, raw });
    });
  });
}

const PROMPT = '› '; // приглашение CLI
const promptAfter = (re) => `${re}[\\s\\S]*${PROMPT}`;

/* ---------------------------------- тесты ---------------------------------- */

async function main() {
  const llm = await startFakeLlm({ chunkDelayMs: 300, slowChunks: 60, slowDelayMs: 300, cutAfter: 3 });

  /* 1. Стриминг ------------------------------------------------------------ */

  {
    const home = makeHome('stream', llm.url('stream'));
    const r = await runCli(home, [
      { after: PROMPT, delay: 100, send: 'привет\r' },
      { after: promptAfter('третий кусок\\.'), delay: 100, send: CTRL_C },
    ]);
    await check('стриминг: CLI печатает ответ несколькими кусками в разные моменты', () => {
      assert.ok(!r.timedOut, 'CLI не завершился за отведённое время');
      const pieces = r.writes.filter((w) => STREAM_CHUNKS.some((c) => w.out.includes(c.trim())));
      assert.ok(pieces.length >= 3, `кусков ответа в stdout: ${pieces.length}, ожидалось ≥3`);
      const span = pieces[pieces.length - 1].t - pieces[0].t;
      assert.ok(span >= 600, `куски пришли за ${span} мс — похоже, одним блоком`);
    });
    await check('стриминг: в журнал попадает ответ целиком, а не кусками', () => {
      assert.deepStrictEqual(assistantTexts(journal(home)), [STREAM_CHUNKS.join('')]);
    });
  }

  for (const mode of ['nostream', 'json']) {
    const config = { ...loadConfig(), provider: 'openai', baseUrl: llm.url(mode), apiKey: 'test', workdir: TMP_ROOT, mcpServers: {} };
    const session = new Session();
    const deltas = [];
    const agent = new Agent({ config, session, mcp: null, emit: (ev) => ev.type === 'assistant_text' && deltas.push(ev.text) });
    const before = llm.requests.length;
    await agent.send('ответь');
    const reqs = llm.requests.slice(before);
    const what = mode === 'nostream' ? 'провайдер отверг stream (400)' : 'вместо SSE пришёл JSON';
    await check(`запасной режим: ${what} — ответ собран целиком`, () => {
      assert.deepStrictEqual(assistantTexts(Session.load(session.id).messages), [WHOLE_TEXT]);
      assert.strictEqual(deltas.join(''), WHOLE_TEXT);
      if (mode === 'nostream') assert.deepStrictEqual(reqs.map((q) => q.stream), [true, false], 'ожидался повтор без stream');
    });
  }

  /* 2. «Стоп» -------------------------------------------------------------- */

  {
    const home = makeHome('abort', llm.url('stream'));
    const r = await runCli(home, [
      { after: PROMPT, delay: 100, send: 'расскажи долго\r' },
      { after: 'слово3 ', delay: 300, send: CTRL_C }, // посреди генерации
      { after: promptAfter('прервано пользователем'), delay: 100, send: 'привет\r' },
      { after: promptAfter('третий кусок\\.'), delay: 100, send: CTRL_C },
    ]);
    const texts = assistantTexts(journal(home));
    await check('Стоп: CLI печатает «[прервано пользователем]»', () => {
      assert.ok(!r.timedOut, 'CLI завис');
      assert.match(r.out, /\[прервано пользователем\]/);
    });
    await check('Стоп: полученный текст сохранён в журнал с пометкой', () => {
      const partial = texts[0] || '';
      assert.match(partial, /^слово1 слово2 слово3 /, 'нет начала полученного текста');
      assert.match(partial, /\n\n\[прервано пользователем\]$/, 'нет пометки в конце');
      assert.ok(!/слово60/.test(partial), 'сохранён весь поток — прерывания не было');
    });
    await check('Стоп: CLI жив — следующий запрос проходит', () => {
      assert.strictEqual(texts[1], STREAM_CHUNKS.join(''));
      assert.strictEqual(r.exit, 0);
    });
  }

  /* 3. Ctrl+C в покое и обрыв ----------------------------------------------- */

  {
    const home = makeHome('idle', llm.url('stream'));
    const started = Date.now();
    const r = await runCli(home, [{ after: PROMPT, delay: 200, send: CTRL_C }], 5000);
    await check('Ctrl+C в покое: CLI выходит с кодом 0 и не зависает на вопросе', () => {
      assert.ok(!r.timedOut, `CLI не вышел за 5 с (ожидающий question() завис)`);
      assert.strictEqual(r.exit, 0);
      assert.ok(Date.now() - started < 5000);
    });
  }

  {
    const home = makeHome('cut', llm.url('stream'));
    const r = await runCli(home, [
      { after: PROMPT, delay: 100, send: 'оборви\r' },
      { after: promptAfter('оборвано'), delay: 100, send: 'привет\r' },
      { after: promptAfter('третий кусок\\.'), delay: 100, send: CTRL_C },
    ]);
    const texts = assistantTexts(journal(home));
    await check('обрыв посреди генерации: текст сохранён с пометкой о причине', () => {
      assert.ok(!r.timedOut, 'CLI завис после обрыва');
      assert.match(texts[0] || '', /^часть1 часть2 часть3 \n\n\[прервано: соединение оборвано посреди ответа/);
    });
    await check('обрыв посреди генерации: CLI жив и выходит с кодом 0', () => {
      assert.strictEqual(texts[1], STREAM_CHUNKS.join(''));
      assert.strictEqual(r.exit, 0);
    });
  }

  {
    // Ctrl+C на «Разрешить …? [y/N]» — это отказ от одного вызова, а не «Стоп»
    // всего хода: модель должна получить отказ и продолжить.
    const home = makeHome('confirm', llm.url('stream'), { permissionMode: 'ask' });
    const r = await runCli(home, [
      { after: PROMPT, delay: 100, send: 'запиши файл\r' },
      { after: 'Разрешить write_file', delay: 200, send: CTRL_C },
      { after: promptAfter('Продолжаю после инструмента'), delay: 100, send: CTRL_C },
    ]);
    const messages = journal(home);
    const results = messages.flatMap((m) => m.blocks).filter((b) => b.type === 'tool_result');
    await check('Ctrl+C на подтверждении: вызов отклонён, файл не создан', () => {
      assert.ok(!r.timedOut, 'CLI завис');
      assert.match(r.out, /✗ write_file: отклонено пользователем/);
      assert.strictEqual(results.length, 1);
      assert.ok(results[0].is_error && /отклонил/.test(results[0].content), 'отказ не записан в журнал');
      assert.ok(!fs.existsSync(path.join(home, 'work', 'denied.txt')), 'файл создан, хотя вызов отклонён');
    });
    await check('Ctrl+C на подтверждении: следующий запрос модели проходит, а не aborted', () => {
      assert.doesNotMatch(r.out, /Сеть недоступна|aborted|прервано/, 'прерывание утекло в следующий запрос');
      assert.deepStrictEqual(assistantTexts(messages).filter(Boolean), [AFTER_TOOL_TEXT]);
      assert.strictEqual(r.exit, 0);
    });
  }

  {
    // «Стоп» до первого байта ответа: fetch() отменён — это прерывание, а не сбой сети.
    const home = makeHome('abort-wait', llm.url('stream'));
    const r = await runCli(home, [
      { after: PROMPT, delay: 100, send: 'жди\r' },
      { after: 'жди', delay: 500, send: CTRL_C },
      { after: PROMPT, delay: 100, send: 'привет\r' },
      { after: promptAfter('третий кусок\\.'), delay: 100, send: CTRL_C },
    ]);
    await check('Стоп до ответа сервера: не «Сеть недоступна», CLI жив', () => {
      assert.ok(!r.timedOut, 'CLI завис');
      assert.doesNotMatch(r.out, /Сеть недоступна/, 'отмена показана как сетевой сбой');
      assert.deepStrictEqual(assistantTexts(journal(home)), [STREAM_CHUNKS.join('')]);
      assert.strictEqual(r.exit, 0);
    });
  }

  /* 4. Сжатие контекста ------------------------------------------------------ */

  const long = Array.from({ length: 300 }, (_, i) => `строка ${String(i).padStart(3, '0')} ${'x'.repeat(20)}`).join('\n');

  await check('truncateToolResult: начало и конец целы, середина вырезана', () => {
    const t = truncateToolResult(long, 400);
    assert.ok(t.startsWith(long.slice(0, 800)), 'начало (200 токенов = 800 символов) не совпадает');
    assert.ok(t.endsWith(long.slice(-400)), 'конец (100 токенов = 400 символов) не совпадает');
    assert.ok(!t.includes('строка 150'), 'середина не вырезана');
    assert.ok(estimateTokens(t) < 400, `после усечения ${estimateTokens(t)} токенов`);
  });

  await check('truncateToolResult: короткий текст и limit 0 не трогает', () => {
    const short = 'x'.repeat(1000);
    assert.strictEqual(truncateToolResult(short, 400), short);
    assert.strictEqual(truncateToolResult(long, 0), long);
  });

  const conversation = () => [
    { role: 'user', blocks: [{ type: 'text', text: 'прочитай файл' }] },
    { role: 'assistant', blocks: [{ type: 'tool_use', id: 'a', name: 'read_file', input: { path: 'a.txt' } }] },
    { role: 'user', blocks: [{ type: 'tool_result', id: 'a', content: long, is_error: false }] },
    { role: 'assistant', blocks: [{ type: 'text', text: 'прочитал' }] },
    { role: 'user', blocks: [{ type: 'text', text: 'а теперь второй' }] },
    { role: 'assistant', blocks: [{ type: 'tool_use', id: 'b', name: 'read_file', input: { path: 'b.txt' } }] },
    { role: 'user', blocks: [{ type: 'tool_result', id: 'b', content: long, is_error: false }] },
  ];

  await check('prepareForRequest: режет прошлые ходы, свежие результаты не трогает', () => {
    const msgs = conversation();
    const out = prepareForRequest(msgs, 400);
    assert.match(out[2].blocks[0].content, /пропущено ~\d+ токенов из середины вывода/);
    assert.strictEqual(out[6], msgs[6], 'результат после последнего сообщения пользователя изменён');
    assert.strictEqual(out[6].blocks[0].content, long);
  });

  await check('prepareForRequest: исходный массив не меняется', () => {
    const msgs = conversation();
    const snapshot = JSON.parse(JSON.stringify(msgs));
    const out = prepareForRequest(msgs, 400);
    assert.notStrictEqual(out, msgs);
    assert.deepStrictEqual(msgs, snapshot);
  });

  // compactIfNeeded и сверка со скриптом — на конфиге из временного HOME
  const mainConfig = { provider: 'openai', model: 'fake', baseUrl: llm.url(), apiKey: 'test', workdir: TMP_ROOT, mcpServers: {} };
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify(mainConfig, null, 2));

  await check('compactIfNeeded: учитывает системный промпт и схемы инструментов', () => {
    const chat = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      blocks: [{ type: 'text', text: `реплика ${i} ${'слово '.repeat(40)}` }],
    }));
    const agent = new Agent({ config: loadConfig(), session: null, mcp: null });
    const oldFormula = estimateMessagesTokens(chat, agent.system); // история + промпт, без схем
    const schemas = toolSchemaTokens(agent.toolDefs);

    // Бюджет вмещает старую формулу, но не запрос со схемами — сжатие должно сработать.
    agent.config = { ...agent.config, contextBudget: oldFormula + Math.floor(schemas / 2) };
    agent.loadHistory(chat);
    assert.strictEqual(agent.requestTokens(), oldFormula + schemas);
    agent.compactIfNeeded();
    assert.match(agent.history[0].blocks[0].text, /Ранняя часть разговора сокращена/);

    // Контроль: бюджет вмещает всё — ничего не выбрасывается.
    const agent2 = new Agent({ config: { ...loadConfig(), contextBudget: oldFormula + schemas + 10 }, session: null, mcp: null });
    agent2.loadHistory(chat);
    agent2.compactIfNeeded();
    assert.strictEqual(agent2.history.length, chat.length);
  });

  /**
   * Сценарий, в котором цикл compactIfNeeded останавливается ровно после
   * выброшенного вызова инструмента:
   *   #0 user: большой вопрос (~1000 токенов)
   *   #1 assistant: tool_use t1 (~200 токенов в аргументах)
   *   #2 user: tool_result t1 (короткий)
   *   #3..#9 обычная переписка
   * Бюджет подобран так, что после выброса #0 запрос ещё > 75% бюджета,
   * а после выброса #1 — уже ≤ 75%. Цикл останавливается, и первым
   * в истории (после пометки о сокращении) оказывается tool_result без вызова.
   */
  const orphanScenario = () => [
    { role: 'user', blocks: [{ type: 'text', text: `вопрос ${'а'.repeat(4000)}` }] },
    { role: 'assistant', blocks: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'x.txt', note: 'б'.repeat(720) } }] },
    { role: 'user', blocks: [{ type: 'tool_result', id: 't1', content: 'ok', is_error: false }] },
    { role: 'assistant', blocks: [{ type: 'text', text: 'прочитал' }] },
    ...Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', blocks: [{ type: 'text', text: `реплика ${i}` }] })),
  ];

  /** Нарушения парности: результат без предшествующего вызова, вызов без результата. */
  function pairingProblems(messages) {
    const problems = [];
    const calls = new Set();
    const answered = new Set();
    for (const [i, m] of messages.entries()) {
      for (const b of m.blocks || []) {
        if (b.type === 'tool_use') calls.add(b.id);
        if (b.type === 'tool_result') {
          if (!calls.has(b.id)) problems.push(`#${i}: результат ${b.id} без вызова`);
          answered.add(b.id);
        }
      }
    }
    for (const id of calls) if (!answered.has(id)) problems.push(`вызов ${id} без результата`);
    return problems;
  }

  await check('compactIfNeeded: не оставляет результат инструмента без его вызова', () => {
    const msgs = orphanScenario();
    const probe = new Agent({ config: loadConfig(), session: null, mcp: null });
    probe.loadHistory(msgs);
    const full = probe.requestTokens();
    probe.loadHistory(msgs.slice(1));
    const withoutQuestion = probe.requestTokens();
    probe.loadHistory(msgs.slice(2));
    const withoutCall = probe.requestTokens();
    const budget = Math.ceil((withoutCall + 5) / 0.75);
    // Предусловия: иначе тест прошёл бы впустую, не воспроизведя ситуацию.
    assert.ok(full > budget, 'сценарий: история должна превышать бюджет');
    assert.ok(withoutQuestion > budget * 0.75, 'сценарий: после выброса вопроса запрос ещё выше 75%');
    assert.ok(withoutCall <= budget * 0.75, 'сценарий: после выброса вызова запрос уже в пределах 75%');

    const agent = new Agent({ config: { ...loadConfig(), contextBudget: budget }, session: null, mcp: null });
    agent.loadHistory(msgs);
    agent.compactIfNeeded();
    assert.deepStrictEqual(pairingProblems(agent.history), []);
    assert.match(agent.history[0].blocks[0].text, /Ранняя часть разговора сокращена/);
  });

  await check('compactIfNeeded: история из одной пары вызов—результат не опустошается', () => {
    const pair = orphanScenario().slice(0, 3);
    const agent = new Agent({ config: { ...loadConfig(), contextBudget: 1 }, session: null, mcp: null });
    agent.loadHistory(pair);
    agent.compactIfNeeded();
    assert.strictEqual(agent.history.length, 3, 'выброшено больше, чем позволяет минимум');
    assert.deepStrictEqual(pairingProblems(agent.history), []);
  });

  await check('requestTokens агента совпадает с session-tokens.js --after-truncation', async () => {
    const file = path.join(TMP_ROOT, 'sample-session.jsonl');
    fs.writeFileSync(file, conversation().concat([{ role: 'user', blocks: [{ type: 'text', text: 'итог?' }] }])
      .map((message) => JSON.stringify({ ts: 0, entry: { kind: 'message', message } })).join('\n') + '\n');
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'session-tokens.js'), '--after-truncation', file], {
        env: { ...process.env, D3M3NK0_HOME: HOME },
      });
      let s = '';
      child.stdout.on('data', (d) => (s += d));
      child.on('close', (code) => (code === 0 ? resolve(s) : reject(new Error(`скрипт вышел с кодом ${code}`))));
    });
    const line = stdout.split('\n').find((l) => l.startsWith('Запрос целиком'));
    assert.ok(line, 'в выводе скрипта нет строки «Запрос целиком»');
    const scriptAfter = Number(line.split('→')[1].replace(/\D/g, ''));
    const agent = new Agent({ config: loadConfig(), session: null, mcp: null });
    agent.loadHistory(fileMessages(file));
    assert.strictEqual(agent.requestTokens(), scriptAfter);
  });

  /* 5. Пометки и границы ----------------------------------------------------- */

  await check('пометка: «пропущено ~N токенов из середины вывода», N = размер середины', () => {
    const t = truncateToolResult(long, 400);
    const m = t.match(/\n\[…пропущено ~(\d+) токенов из середины вывода; ниже приведён его конец…\]\n/);
    assert.ok(m, 'текст пометки изменился');
    assert.strictEqual(Number(m[1]), estimateTokens(long.slice(800, long.length - 400)));
  });

  // Сессии в HOME теста (D3M3NK0_HOME выставлен до загрузки ядра).
  const mkSession = (text) => {
    const s = new Session();
    s.append({ kind: 'message', message: { role: 'user', blocks: [{ type: 'text', text }] } });
    return s.id;
  };
  const sOld = mkSession('старая');
  const sNew = mkSession('новая');
  fs.utimesSync(Session.fileOf(sOld), new Date(2020, 0, 1), new Date(2020, 0, 1));

  await check('сессии: закреплённая идёт первой, даже если она старше', () => {
    Session.setPinned(sOld, true);
    const list = Session.list();
    assert.strictEqual(list[0].id, sOld, 'закреплённая не первая');
    assert.strictEqual(list[0].pinned, true);
    assert.ok(list.some((s) => s.id === sNew && !s.pinned), 'вторая сессия пропала или закреплена');
  });

  await check('сессии: открепить возвращает обычный порядок', () => {
    Session.setPinned(sOld, false);
    const ids = Session.list().map((s) => s.id);
    assert.ok(ids.indexOf(sNew) < ids.indexOf(sOld), 'старая всё ещё выше новой');
  });

  await check('сессии: удаление через trash убирает файл и закрепление', async () => {
    Session.setPinned(sNew, true);
    const trashed = [];
    await Session.remove(sNew, { trash: async (f) => { trashed.push(f); fs.unlinkSync(f); } });
    assert.deepStrictEqual(trashed, [Session.fileOf(sNew)], 'trash вызван не с тем файлом');
    assert.ok(!Session.list().some((s) => s.id === sNew), 'сессия осталась в списке');
    assert.ok(!JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', 'pinned.json'), 'utf8')).includes(sNew), 'осталась в pinned.json');
  });

  await check('сессии: id с путём отвергается, файлы вне папки не трогаются', async () => {
    const outside = path.join(HOME, 'victim.jsonl');
    fs.writeFileSync(outside, 'x');
    await assert.rejects(() => Session.remove('../victim'), /Недопустимый id/);
    assert.throws(() => Session.setPinned('..\\victim', true), /Недопустимый id/);
    assert.ok(fs.existsSync(outside), 'файл вне папки сессий удалён');
  });

  await check('плагины: выключенный не подключается, сводка показывает off/ok/error', async () => {
    const { McpManager, describePlugins } = require('../src/core/mcp');
    const fake = { command: process.execPath, args: [path.join(__dirname, 'helpers', 'fake-mcp.js')] };
    const servers = {
      on: fake,
      off: { ...fake, disabled: true },
      broken: { command: path.join(TMP_ROOT, 'нет-такой-программы.exe') },
    };
    const m = new McpManager();
    try {
      const report = await m.connectAll(servers);
      assert.deepStrictEqual(report.map((r) => r.server).sort(), ['broken', 'on'], 'выключенный попал в подключение');
      assert.deepStrictEqual(m.toolDefs.map((t) => t.name), ['mcp__on__ping']);
      const states = Object.fromEntries(describePlugins(servers, report).map((p) => [p.name, p.state]));
      assert.deepStrictEqual(states, { on: 'ok', off: 'off', broken: 'error' });
      assert.strictEqual(describePlugins({ fresh: fake }, [])[0].state, 'pending');
    } finally {
      await m.closeAll();
    }
  });

  await check('плагины: молчащий сервер не вешает сборку — ошибка по таймауту, остальные подключены', async () => {
    const { McpManager } = require('../src/core/mcp');
    const fake = { command: process.execPath, args: [path.join(__dirname, 'helpers', 'fake-mcp.js')] };
    const silent = { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], startupTimeoutMs: 800 };
    const m = new McpManager();
    const t0 = Date.now();
    try {
      const report = await m.connectAll({ silent, on: fake });
      const ms = Date.now() - t0;
      assert.ok(ms < 10000, `сборка шла ${ms} мс`);
      const bad = report.find((r) => r.server === 'silent');
      assert.ok(bad && !bad.ok && /не ответил/.test(bad.error), `нет ошибки таймаута: ${JSON.stringify(bad)}`);
      assert.ok(report.find((r) => r.server === 'on')?.ok, 'рабочий плагин не подключился после зависшего');
    } finally {
      await m.closeAll();
    }
  });

  const { parseBlocks, parseInline } = require('../src/renderer/markdown');

  await check('markdown: жирный, курсив, `код` и snake_case без ложного курсива', () => {
    const t = parseInline('**жир** и *кур* и `read_file` и snake_case_name');
    assert.deepStrictEqual(t.map((x) => x.t), ['bold', 'text', 'italic', 'text', 'code', 'text']);
    assert.strictEqual(t[5].v, ' и snake_case_name');
  });

  await check('markdown: блоки — список, таблица, код, незакрытый код при стриминге', () => {
    const b = parseBlocks('Текст\n\n- а\n- б\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n```js\nlet a\n```\n```py\nне закрыт');
    assert.deepStrictEqual(b.map((x) => x.type), ['para', 'list', 'table', 'code', 'code']);
    assert.strictEqual(b[2].rows.length, 1);
    assert.strictEqual(b[3].lang, 'js');
    assert.strictEqual(b[4].text, 'не закрыт');
  });

  await check('markdown: опасные ссылки и HTML остаются текстом', () => {
    const t = parseInline('[x](javascript:alert(1)) <img src=x onerror=alert(1)> [ok](https://example.org)');
    assert.ok(!t.some((x) => x.t === 'link' && /javascript/i.test(x.href)), 'javascript: стал ссылкой');
    assert.ok(t.some((x) => x.t === 'text' && x.v.includes('<img')), 'HTML пропал из текста');
    assert.ok(t.some((x) => x.t === 'link' && x.href === 'https://example.org'), 'нормальная ссылка не распознана');
  });

  const { highlightCode } = require('../src/renderer/markdown');
  const joined = (tokens) => tokens.map((t) => t.v).join('');

  await check('подсветка кода: склеенные куски равны исходному коду (js, python, powershell, json)', () => {
    const samples = [
      ['js', 'const x = await fetch("a\\"b"); // коммент\n/* блок */ let n = 0x1F + 4.5;'],
      ['python', 'def f(a):\n    """док"""\n    return \'s\'  # c\nprint(f(3))'],
      ['powershell', '$p = Get-ChildItem -Path "C:\\x" # список\nWrite-Host $p.Count'],
      ['json', '{"a": 1, "b": [true, null], "c": "x"}'],
      ['js', 'незакрытая "строка\nи `шаблон'],
    ];
    for (const [lang, code] of samples) assert.strictEqual(joined(highlightCode(code, lang)), code, `${lang}: текст изменился`);
  });

  await check('подсветка кода: виды кусков — ключевые слова, строки, числа, комментарии, функции', () => {
    const kinds = (code, lang) => highlightCode(code, lang).filter((t) => t.t).map((t) => `${t.t}:${t.v}`);
    assert.deepStrictEqual(kinds('return f(2) // ok', 'js'), ['kw:return', 'fn:f', 'num:2', 'com:// ok']);
    assert.deepStrictEqual(kinds('x = "s"  # c', 'python'), ['str:"s"', 'com:# c']);
    assert.deepStrictEqual(kinds('Get-Item $a', 'powershell'), ['fn:Get-Item', 'fn:$a']);
    assert.ok(kinds('# не комментарий в js', 'js').every((k) => !k.startsWith('com:')), '# в js стал комментарием');
    assert.deepStrictEqual(highlightCode('npm test', 'text'), [{ t: null, v: 'npm test' }]);
  });

  await check('подсветка кода: HTML из ответа остаётся текстом, не тегом', () => {
    const code = '<img src=x onerror="alert(1)"><script>x()</script>';
    const tokens = highlightCode(code, 'html');
    assert.strictEqual(joined(tokens), code);
    assert.ok(tokens.every((t) => t.t === null || ['kw', 'str', 'num', 'com', 'fn'].includes(t.t)), 'неизвестный тип куска');
  });

  await check('Agent.setModel: модель меняется, история остаётся, промпт обновлён', () => {
    const a = new Agent({ config: { provider: 'openai', model: 'old-model', workdir: TMP_ROOT }, session: null, mcp: null });
    a.loadHistory([{ role: 'user', blocks: [{ type: 'text', text: 'привет' }] }]);
    a.setModel('new-model');
    assert.strictEqual(a.config.model, 'new-model');
    assert.strictEqual(a.history.length, 1, 'история потеряна');
    assert.ok(a.system.includes('new-model') && !a.system.includes('old-model'), 'промпт не обновлён');
  });

  const rulesDir = path.join(TMP_ROOT, 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  const baseCfg = { provider: 'openai', model: 'fake' };

  await check('AGENTS.md: без файла системный промпт без раздела правил', () => {
    const sys = buildSystemPrompt({ ...baseCfg, workdir: rulesDir });
    assert.ok(!/AGENTS\.md/.test(sys), 'раздел правил появился без файла');
  });

  await check('AGENTS.md: правила из рабочей папки попадают в системный промпт', () => {
    fs.writeFileSync(path.join(rulesDir, 'AGENTS.md'), '# Правила\n- ПРАВИЛО-МЕТКА-42\n');
    const sys = buildSystemPrompt({ ...baseCfg, workdir: rulesDir });
    assert.ok(/ПРАВИЛО-МЕТКА-42/.test(sys), 'текст правил не попал в промпт');
  });

  await check('AGENTS.md: длинный файл обрезается до лимита с пометкой', () => {
    fs.writeFileSync(path.join(rulesDir, 'AGENTS.md'), 'я'.repeat(RULES_MAX_CHARS * 2));
    const rules = loadProjectRules(rulesDir);
    assert.ok(rules.length < RULES_MAX_CHARS + 200, `правила не обрезаны: ${rules.length}`);
    assert.ok(/обрезан/.test(rules), 'нет пометки об обрезке');
  });

  await check('test/smoke.js по-прежнему проходит (границы рабочей папки)', async () => {
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(__dirname, 'smoke.js')], { stdio: 'ignore' });
      child.on('close', resolve);
    });
    assert.strictEqual(code, 0, `smoke.js вышел с кодом ${code}`);
  });

  /* ------------------------- устойчивость: тайм-аут, повтор ------------------------- */

  const { classify, fallbackModels } = require('../src/core/resilience');

  await check('устойчивость: молчащая → перегруженная (повтор) → рабочая модель отвечает', async () => {
    const config = {
      ...loadConfig(), provider: 'openai', baseUrl: llm.url('stream'), apiKey: 'test', workdir: TMP_ROOT, mcpServers: {},
      model: 'model-silent', fallbackModels: ['model-429', 'model-ok'], responseTimeoutMs: 600, retryDelayMs: 50,
    };
    const infos = [];
    let text = '';
    const agent = new Agent({ config, session: null, mcp: null, emit: (e) => { if (e.type === 'info') infos.push(e.message); if (e.type === 'assistant_text') text += e.text; } });
    const before = llm.requests.length;
    const t0 = Date.now();
    await agent.send('ответь');
    const models = llm.requests.slice(before).map((r) => r.model);
    assert.deepStrictEqual(models, ['model-silent', 'model-429', 'model-429', 'model-ok'], `порядок моделей: ${models}`);
    assert.strictEqual(text, STREAM_CHUNKS.join(''), 'ответ рабочей модели не пришёл');
    assert.ok(infos.some((m) => /model-silent: не ответила вовремя — переключаюсь на model-429/.test(m)), infos.join(' | '));
    assert.ok(infos.some((m) => /model-429: перегружена \(429\) — повтор/.test(m)), infos.join(' | '));
    assert.ok(infos.some((m) => /запасная модель: model-ok/.test(m)), infos.join(' | '));
    assert.ok(Date.now() - t0 < 8000, 'слишком долго');
  });

  await check('устойчивость: все модели не отвечают — понятная ошибка, агент свободен', async () => {
    const config = { ...loadConfig(), provider: 'openai', baseUrl: llm.url('stream'), apiKey: 'test', workdir: TMP_ROOT, mcpServers: {}, model: 'model-429', fallbackModels: [], retryDelayMs: 20 };
    const errors = [];
    const agent = new Agent({ config, session: null, mcp: null, emit: (e) => e.type === 'error' && errors.push(e.message) });
    await agent.send('ответь');
    assert.ok(errors.some((m) => /Ни одна модель не ответила/.test(m)), errors.join(' | '));
    assert.strictEqual(agent.busy, false);
  });

  await check('устойчивость: «Стоп» во время ожидания — не повтор, а остановка', async () => {
    const config = { ...loadConfig(), provider: 'openai', baseUrl: llm.url('stream'), apiKey: 'test', workdir: TMP_ROOT, mcpServers: {}, model: 'model-silent', fallbackModels: ['model-ok'], responseTimeoutMs: 5000 };
    const infos = [];
    const agent = new Agent({ config, session: null, mcp: null, emit: (e) => e.type === 'info' && infos.push(e.message) });
    const before = llm.requests.length;
    const p = agent.send('ответь');
    await new Promise((r) => setTimeout(r, 300));
    agent.abort();
    await p;
    assert.ok(infos.some((m) => /Остановлено пользователем/.test(m)), infos.join(' | '));
    assert.deepStrictEqual(llm.requests.slice(before).map((r) => r.model), ['model-silent'], 'после Стоп ушёл запрос к запасной');
  });

  await check('устойчивость: виды ошибок и запасные модели по умолчанию', () => {
    assert.strictEqual(classify(new Error('OpenAI-совместимый API 429: slow down')), 'busy');
    assert.strictEqual(classify(new Error('Anthropic API 529: overloaded')), 'server');
    assert.strictEqual(classify(new Error('Сеть недоступна: x (ECONNRESET)')), 'network');
    assert.strictEqual(classify(new Error('OpenAI-совместимый API 401: bad key')), null, '401 повторять бессмысленно');
    const nv = fallbackModels({ model: 'nvidia/nemotron-3.5-lightning-30b-a3b', baseUrl: 'https://integrate.api.nvidia.com/v1', fallbackModels: null });
    assert.ok(nv.length >= 2 && !nv.includes('nvidia/nemotron-3.5-lightning-30b-a3b'), nv.join());
    assert.deepStrictEqual(fallbackModels({ model: 'x', baseUrl: 'https://api.anthropic.com', fallbackModels: null }), []);
  });

  /* ------------------------------ read_pdf (PDF) ------------------------------- */

  /** Настоящий маленький PDF: по строке текста на страницу, смещения xref посчитаны. */
  function makePdf(lines) {
    const objs = [];
    const add = (s) => objs.push(s) && objs.length;
    const catalog = add('<< /Type /Catalog /Pages 2 0 R >>');
    add('PAGES');
    const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    const kids = [];
    for (const line of lines) {
      const stream = `BT /F1 14 Tf 72 720 Td (${line}) Tj ET`;
      const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
    }
    objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    let out = '%PDF-1.4\n';
    const offsets = [];
    objs.forEach((o, i) => {
      offsets.push(Buffer.byteLength(out, 'latin1'));
      out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }

  const { parsePages: pp, runTool: rt } = require('../src/core/tools');
  const pdfDir = path.join(TMP_ROOT, 'pdfs');
  fs.mkdirSync(pdfDir, { recursive: true });
  fs.writeFileSync(path.join(pdfDir, 'cours.pdf'), makePdf(Array.from({ length: 12 }, (_, i) => `Bonjour RDM page ${i + 1}`)));
  const pdfCtx = { workdir: pdfDir, allowOutside: false };

  await check('read_pdf: выбранные страницы, подписи, подсказка «дальше»', async () => {
    const out = await rt('read_pdf', { path: 'cours.pdf', pages: '2, 4-5' }, pdfCtx);
    assert.ok(/12 стр\. Показаны страницы 2, 4–5/.test(out), out.slice(0, 120));
    for (const n of [2, 4, 5]) assert.ok(out.includes(`--- страница ${n} ---\nBonjour RDM page ${n}`), `нет страницы ${n}`);
    assert.ok(!out.includes('page 3'), 'лишняя страница 3');
    assert.ok(/pages "6-12"/.test(out), 'нет подсказки, как читать дальше');
  });

  await check('read_pdf: без pages — первые 10 страниц', async () => {
    const out = await rt('read_pdf', { path: 'cours.pdf' }, pdfCtx);
    assert.ok(out.includes('page 10') && !out.includes('page 11'), 'не первые 10 страниц');
    assert.ok(/pages "11-12"/.test(out));
  });

  await check('read_pdf: неверные страницы, не-PDF и путь вне папки отвергаются', async () => {
    assert.deepStrictEqual(pp('3, 1-2, 2', 12), [1, 2, 3]);
    assert.throws(() => pp('0', 12), /вне документа/);
    assert.throws(() => pp('15', 12), /вне документа/);
    assert.deepStrictEqual(pp('1-3', 1), [1], 'диапазон за концом документа не обрезан');
    assert.deepStrictEqual(pp('11-40', 12), [11, 12]);
    assert.throws(() => pp('1-25', 30), /не больше/);
    assert.throws(() => pp('пять', 12), /Не понял/);
    fs.writeFileSync(path.join(pdfDir, 'a.txt'), 'x');
    await assert.rejects(() => rt('read_pdf', { path: 'a.txt' }, pdfCtx), /не PDF/);
    await assert.rejects(() => rt('read_pdf', { path: path.join(TMP_ROOT, 'x.pdf') }, pdfCtx), /вне рабочей папки/);
  });

  /* --------------------------- view_image (картинки) --------------------------- */

  const { runTool } = require('../src/core/tools');
  const { toOpenAIMessages, toAnthropicMessages } = require('../src/core/providers');
  // Настоящий PNG 1×1 (красный пиксель).
  const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
  const picDir = path.join(TMP_ROOT, 'pics');
  fs.mkdirSync(picDir, { recursive: true });
  fs.writeFileSync(path.join(picDir, 'pic.png'), PNG_1PX);
  fs.writeFileSync(path.join(picDir, 'notes.txt'), 'текст');
  const picCtx = { workdir: picDir, allowOutside: false };

  await check('view_image: отдаёт картинку base64 и тип; не-картинку и путь вне папки отвергает', async () => {
    const out = await runTool('view_image', { path: 'pic.png' }, picCtx);
    assert.strictEqual(out.image.media_type, 'image/png');
    assert.strictEqual(out.image.data, PNG_1PX.toString('base64'));
    assert.strictEqual(out.image.path, 'pic.png');
    assert.ok(/pic\.png/.test(out.text));
    await assert.rejects(() => runTool('view_image', { path: 'notes.txt' }, picCtx), /не поддержан/);
    await assert.rejects(() => runTool('view_image', { path: path.join(TMP_ROOT, 'x.png') }, picCtx), /вне рабочей папки/);
  });

  await check('view_image: в окне большие картинки уменьшаются через resizeImage', async () => {
    let asked = null;
    const resizeImage = async (buf, opts) => {
      asked = opts;
      return { data: Buffer.from('jpegdata'), mediaType: 'image/jpeg', width: 800, height: 600 };
    };
    const out = await runTool('view_image', { path: 'pic.png' }, { ...picCtx, resizeImage });
    assert.ok(asked && asked.maxSide > 0, 'resizeImage не вызван');
    assert.strictEqual(out.image.media_type, 'image/jpeg');
    assert.strictEqual(out.image.data, Buffer.from('jpegdata').toString('base64'));
    assert.ok(/800×600/.test(out.text), 'в тексте нет нового размера');
  });

  const imgHistory = () => [
    { role: 'user', blocks: [{ type: 'text', text: 'посмотри' }] },
    { role: 'assistant', blocks: [{ type: 'tool_use', id: 'c1', name: 'view_image', input: { path: 'pic.png' } }] },
    { role: 'user', blocks: [{ type: 'tool_result', id: 'c1', content: 'Картинка pic.png', image: { media_type: 'image/png', data: 'QUJD', path: 'pic.png' } }] },
  ];

  await check('картинка → OpenAI: ответ инструмента текстом, картинка следующим сообщением user', () => {
    const msgs = toOpenAIMessages('sys', imgHistory());
    assert.deepStrictEqual(msgs.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'user']);
    assert.strictEqual(typeof msgs[3].content, 'string');
    const parts = msgs[4].content;
    assert.ok(parts.some((p) => p.type === 'image_url' && p.image_url.url === 'data:image/png;base64,QUJD'), 'нет image_url');
  });

  await check('картинка → Anthropic: image внутри tool_result', () => {
    const msgs = toAnthropicMessages(imgHistory());
    const tr = msgs[2].content[0];
    assert.strictEqual(tr.type, 'tool_result');
    assert.deepStrictEqual(tr.content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } });
  });

  await check('картинка из прошлого хода не уходит в модель снова (даже при limit 0)', () => {
    const hist = [...imgHistory(), { role: 'assistant', blocks: [{ type: 'text', text: 'вижу' }] }, { role: 'user', blocks: [{ type: 'text', text: 'дальше' }] }];
    for (const limit of [0, 400]) {
      const sent = prepareForRequest(hist, limit);
      const tr = sent[2].blocks[0];
      assert.ok(!tr.image.data, `limit ${limit}: base64 остался`);
      assert.ok(/view_image/.test(tr.content), `limit ${limit}: нет пометки`);
      assert.ok(hist[2].blocks[0].image.data, 'исходная история изменилась');
    }
    // Текущий ход — картинка на месте.
    assert.strictEqual(prepareForRequest(imgHistory(), 400)[2].blocks[0].image.data, 'QUJD');
  });

  await check('view_image сквозной: модель получила картинку, в журнал base64 не попал', async () => {
    const config = { ...loadConfig(), provider: 'openai', baseUrl: llm.url('stream'), apiKey: 'test', workdir: picDir, permissionMode: 'ask', mcpServers: {} };
    const session = new Session();
    const events = [];
    const agent = new Agent({ config, session, mcp: null, emit: (ev) => events.push(ev) });
    const before = llm.requests.length;
    await agent.send('посмотри на картинку');
    const reqs = llm.requests.slice(before);
    assert.strictEqual(reqs.length, 2, `запросов к модели: ${reqs.length}`);
    assert.deepStrictEqual(reqs[1].images, [`data:image/png;base64,${PNG_1PX.toString('base64')}`], 'во втором запросе нет картинки');
    const end = events.find((e) => e.type === 'tool_end' && e.name === 'view_image');
    assert.ok(end && end.ok && end.image?.data, 'окно не получило картинку для превью');
    const raw = fs.readFileSync(session.file, 'utf8');
    assert.ok(!raw.includes(PNG_1PX.toString('base64')), 'base64 записан в журнал сессии');
    assert.ok(raw.includes('"path":"pic.png"'), 'в журнале нет пути картинки');
  });

  await llm.close();
}

/** Сообщения из .jsonl по пути (для сверки со скриптом). */
function fileMessages(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l).entry.message);
}

main()
  .catch((e) => {
    console.error(e);
    failed = true;
  })
  .finally(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    if (failed) process.exitCode = 1;
  });
