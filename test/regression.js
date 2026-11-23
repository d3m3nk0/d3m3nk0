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
