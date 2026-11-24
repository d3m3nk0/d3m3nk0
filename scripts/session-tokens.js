'use strict';

/**
 * Замер размера сессии в токенах — подготовка к авто-сжатию истории.
 *
 *   node scripts/session-tokens.js                   последняя сессия
 *   node scripts/session-tokens.js <id>              сессия по id (20261121-150059-98b9)
 *   node scripts/session-tokens.js <путь.jsonl>      сессия по пути к файлу
 *   node scripts/session-tokens.js --all             краткая таблица по всем сессиям
 *   node scripts/session-tokens.js --sample          тестовая сессия в памяти (на диск не пишется)
 *   node scripts/session-tokens.js --after-truncation [<id>|<путь>|--sample]
 *       было → стало, если применить усечение старых результатов инструментов
 *       (то же правило, что агент применяет перед отправкой: src/core/context.js)
 *
 * Токены оцениваются той же функцией, что у сжатия в агенте (estimateTokens:
 * символы / 4, а если не-ASCII больше 30% — символы / 2; плюс фиксированная
 * надбавка за блоки инструментов, как в estimateMessagesTokens). Поэтому цифры
 * совпадают с тем, когда сработает compactIfNeeded. Это оценка, а не настоящий
 * токенизатор.
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, SESSIONS_DIR } = require('../src/core/config');
const { Session } = require('../src/core/session');
const { estimateTokens, estimateMessagesTokens } = require('../src/core/providers');
const { buildSystemPrompt } = require('../src/core/agent');
const { toolSchemas } = require('../src/core/tools');
const { prepareForRequest, toolSchemaTokens } = require('../src/core/context');

// Надбавки за блоки инструментов — как в estimateMessagesTokens (providers.js).
const TOOL_USE_OVERHEAD = 20;
const TOOL_RESULT_OVERHEAD = 10;

const CATEGORIES = [
  ['userText', 'Текст пользователя'],
  ['assistantText', 'Текст ассистента'],
  ['toolUse', 'Вызовы инструментов (аргументы)'],
  ['toolResult', 'Результаты инструментов'],
  ['reasoning', 'Рассуждение'],
];

/* ------------------------------- загрузка -------------------------------- */

/** Сообщения из .jsonl по пути — тот же разбор, что в Session.load, но для любого файла. */
function loadFile(file) {
  const messages = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.entry && rec.entry.kind === 'message') messages.push(rec.entry.message);
    } catch {
      // битая строка не должна ломать замер всей сессии
    }
  }
  return messages;
}

function resolveSession(arg) {
  if (!arg) {
    const latest = Session.list()[0];
    if (!latest) throw new Error(`Сессий нет в ${SESSIONS_DIR}`);
    return { label: latest.id, messages: Session.load(latest.id).messages };
  }
  if (arg.endsWith('.jsonl') || fs.existsSync(arg)) {
    if (!fs.existsSync(arg)) throw new Error(`Файл не найден: ${arg}`);
    return { label: path.basename(arg), messages: loadFile(arg) };
  }
  if (!Session.exists(arg)) throw new Error(`Сессия ${arg} не найдена в ${SESSIONS_DIR}`);
  return { label: arg, messages: Session.load(arg).messages };
}

/** Тестовая сессия: задача, рассуждение, вызов инструмента с объёмным выводом, ответ. */
function sampleSession() {
  const listing = Array.from({ length: 40 }, (_, i) => `  module-${i}.js  ${1200 + i * 37} B`).join('\n');
  const reasoning =
    'The user wants an overview of the project modules. I should list the directory first, ' +
    'then read the main entry point and summarise the architecture in a few sentences. ';
  return [
    { role: 'user', blocks: [{ type: 'text', text: 'Посмотри папку src и кратко опиши архитектуру проекта.' }] },
    {
      role: 'assistant',
      blocks: [
        { type: 'reasoning', text: reasoning.repeat(3) },
        { type: 'text', text: 'Сначала посмотрю, какие модули есть в src.' },
        { type: 'tool_use', id: 'call_1', name: 'list_dir', input: { path: 'src' } },
      ],
    },
    { role: 'user', blocks: [{ type: 'tool_result', id: 'call_1', content: `src/\n${listing}`, is_error: false }] },
    {
      role: 'assistant',
      blocks: [
        { type: 'reasoning', text: reasoning },
        { type: 'tool_use', id: 'call_2', name: 'read_file', input: { path: 'src/module-0.js' } },
      ],
    },
    { role: 'user', blocks: [{ type: 'tool_result', id: 'call_2', content: "'use strict';\n".repeat(120), is_error: false }] },
    {
      role: 'assistant',
      blocks: [{ type: 'text', text: 'В проекте 40 модулей. Точка входа module-0.js подключает остальные по цепочке. '.repeat(4) }],
    },
  ];
}

/* --------------------------------- подсчёт -------------------------------- */

function measure(messages) {
  const sums = Object.fromEntries(CATEGORIES.map(([k]) => [k, { tokens: 0, chars: 0, blocks: 0 }]));
  const heavy = [];
  const add = (key, tokens, chars, where) => {
    sums[key].tokens += tokens;
    sums[key].chars += chars;
    sums[key].blocks += 1;
    heavy.push({ key, tokens, where });
  };

  messages.forEach((m, i) => {
    for (const b of m.blocks || []) {
      if (b.type === 'text') {
        const text = b.text || '';
        add(m.role === 'user' ? 'userText' : 'assistantText', estimateTokens(text), text.length, `#${i + 1} ${m.role}: ${preview(text)}`);
      } else if (b.type === 'tool_use') {
        const json = JSON.stringify(b.input || {});
        add('toolUse', estimateTokens(json) + TOOL_USE_OVERHEAD, json.length, `#${i + 1} вызов ${b.name} ${preview(json)}`);
      } else if (b.type === 'tool_result') {
        const content = b.content || '';
        add('toolResult', estimateTokens(content) + TOOL_RESULT_OVERHEAD, content.length, `#${i + 1} результат: ${preview(content)}`);
      } else if (b.type === 'reasoning' || b.type === 'thinking') {
        const text = b.text || b.thinking || '';
        add('reasoning', estimateTokens(text), text.length, `#${i + 1} рассуждение: ${preview(text)}`);
      }
    }
  });

  const total = Object.values(sums).reduce((n, s) => n + s.tokens, 0);
  const chars = Object.values(sums).reduce((n, s) => n + s.chars, 0);
  heavy.sort((a, b) => b.tokens - a.tokens);
  return { sums, total, chars, heavy };
}

function preview(s) {
  return JSON.stringify(String(s).replace(/\s+/g, ' ').slice(0, 50));
}

/* ---------------------------------- вывод --------------------------------- */

const fmt = (n) => n.toLocaleString('ru-RU');
const pct = (part, whole) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : '—');

function table(rows, align) {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  const line = (r) => r.map((cell, c) => (align[c] === 'r' ? String(cell).padStart(widths[c]) : String(cell).padEnd(widths[c]))).join('  ');
  const sep = widths.map((w) => '─'.repeat(w)).join('  ');
  return [line(rows[0]), sep, ...rows.slice(1, -1).map(line), sep, line(rows[rows.length - 1])].join('\n');
}

function report(label, messages, config) {
  const r = measure(messages);
  const system = buildSystemPrompt(config);
  const systemTokens = estimateTokens(system);
  const schemas = JSON.stringify(toolSchemas());
  const schemaTokens = estimateTokens(schemas);
  const budget = config.contextBudget || 120000;

  console.log(`\nСессия: ${label}   сообщений: ${messages.length}\n`);

  const rows = [['Категория', 'Токены', 'Доля', 'Блоков', 'Символов']];
  for (const [key, title] of CATEGORIES) {
    const s = r.sums[key];
    rows.push([title, fmt(s.tokens), pct(s.tokens, r.total), fmt(s.blocks), fmt(s.chars)]);
  }
  rows.push(['Итого история', fmt(r.total), '100%', fmt(Object.values(r.sums).reduce((n, s) => n + s.blocks, 0)), fmt(r.chars)]);
  console.log(table(rows, ['l', 'r', 'r', 'r', 'r']));

  const history = r.total - r.sums.reasoning.tokens; // рассуждение агент в историю не шлёт
  const perRequest = history + systemTokens + schemaTokens;
  console.log(`
Накладные расходы каждого запроса:
  системный промпт                   ${fmt(systemTokens).padStart(8)}
  схемы встроенных инструментов (${toolSchemas().length})  ${fmt(schemaTokens).padStart(8)}
  схемы MCP-инструментов             не учтены: скрипт не подключается к MCP
                                     (вес печатает npm run cli: «MCP rea: N из M (~Xk токенов)»)

Размер следующего запроса ≈ ${fmt(perRequest)} токенов (история без рассуждения + промпт + схемы)
contextBudget = ${fmt(budget)}: история (с промптом) занимает ${pct(history + systemTokens, budget)} лимита`);
  if (history + systemTokens > budget) console.log('  ! уже больше лимита — compactIfNeeded на следующем шаге начнёт выбрасывать начало');

  console.log('\nСамые тяжёлые блоки:');
  for (const h of r.heavy.slice(0, 5)) console.log(`  ${fmt(h.tokens).padStart(8)}  ${h.where}`);

  // Сверка с формулой агента: история без рассуждения + системный промпт.
  const agentEstimate = estimateMessagesTokens(messages, system);
  const ok = agentEstimate === history + systemTokens;
  console.log(`\nСверка с estimateMessagesTokens агента: ${fmt(agentEstimate)} ${ok ? '= совпадает' : `≠ ${fmt(history + systemTokens)} — формулы разошлись`}`);
  console.log('Оценка: символы / 4; для текста, где не-ASCII больше 30%, — символы / 2 (кириллица).');
}

/** Было → стало: та же история после усечения, которое агент делает перед отправкой. */
function reportTruncation(label, messages, config) {
  const limit = config.toolResultTruncateTokens;
  const sent = prepareForRequest(messages, limit);
  const before = measure(messages);
  const after = measure(sent);
  const system = buildSystemPrompt(config);
  const overhead = estimateTokens(system) + toolSchemaTokens(toolSchemas());

  console.log(`\nСессия: ${label}   сообщений: ${messages.length}`);
  console.log(`Усечение: результаты прошлых ходов длиннее ${fmt(limit || 0)} токенов → начало + конец (config.toolResultTruncateTokens)\n`);

  const rows = [['Категория', 'Было', 'Стало', 'Экономия']];
  for (const [key, title] of CATEGORIES) {
    const b = before.sums[key].tokens;
    const a = after.sums[key].tokens;
    rows.push([title, fmt(b), fmt(a), b ? `${fmt(b - a)} (${pct(b - a, b)})` : '—']);
  }
  rows.push(['Итого история', fmt(before.total), fmt(after.total), `${fmt(before.total - after.total)} (${pct(before.total - after.total, before.total)})`]);
  console.log(table(rows, ['l', 'r', 'r', 'r']));

  const cutBlocks = messages.flatMap((m, i) => (m.blocks || []).map((b, j) => [b, sent[i].blocks[j]])).filter(([b, s]) => b.type === 'tool_result' && b !== s).length;
  const reqBefore = before.total - before.sums.reasoning.tokens + overhead;
  const reqAfter = after.total - after.sums.reasoning.tokens + overhead;
  console.log(`
Обрезано результатов: ${cutBlocks}. Результаты после последнего сообщения пользователя не режутся.
Запрос целиком (история + промпт + встроенные схемы, без MCP): ${fmt(reqBefore)} → ${fmt(reqAfter)} токенов
Журнал сессии на диске не меняется: усечение делается только в копии для запроса.`);
}

function reportAll(config) {
  const list = Session.list();
  if (!list.length) throw new Error(`Сессий нет в ${SESSIONS_DIR}`);
  const rows = [['Сессия', 'Сообщ.', 'Токены', 'Текст', 'Инструменты', 'Рассужд.', 'Начало']];
  let total = 0;
  for (const s of list) {
    const messages = Session.load(s.id).messages;
    const r = measure(messages);
    total += r.total;
    const text = r.sums.userText.tokens + r.sums.assistantText.tokens;
    const tools = r.sums.toolUse.tokens + r.sums.toolResult.tokens;
    rows.push([s.id, fmt(messages.length), fmt(r.total), pct(text, r.total), pct(tools, r.total), pct(r.sums.reasoning.tokens, r.total), (s.title || '').slice(0, 30)]);
  }
  rows.push([`Всего: ${list.length}`, '', fmt(total), '', '', '', '']);
  console.log(`\nСессии в ${SESSIONS_DIR} (contextBudget = ${fmt(config.contextBudget || 120000)})\n`);
  console.log(table(rows, ['l', 'r', 'r', 'r', 'r', 'r', 'l']));
}

/* ---------------------------------- запуск -------------------------------- */

function main() {
  const arg = process.argv[2];
  const config = loadConfig();
  if (arg === '--all') return reportAll(config);
  if (arg === '--sample') return report('тестовая (--sample, в памяти)', sampleSession(), config);
  if (arg === '--after-truncation') {
    const target = process.argv[3];
    if (target === '--sample') return reportTruncation('тестовая (--sample, в памяти)', sampleSession(), config);
    const { label, messages } = resolveSession(target);
    return reportTruncation(label, messages, config);
  }
  const { label, messages } = resolveSession(arg);
  report(label, messages, config);
}

try {
  main();
} catch (e) {
  console.error(`Ошибка: ${e.message}`);
  process.exit(1);
}
