'use strict';

/**
 * Проверка MCP-клиента на реальном сервере (REA).
 *
 * Конфигурация берётся НЕ из кода, а из README.md: тест вырезает JSON-блок
 * из раздела «MCP-серверы» и подключается ровно по нему. Так пример в
 * документации проверяется как есть, а не по памяти автора.
 *
 * Запуск: node test/mcp-smoke.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { McpManager } = require('../src/core/mcp');

const README = path.join(__dirname, '..', 'README.md');

/** Достаёт первый ```json-блок, в котором упоминается "rea". */
function readmeMcpConfig() {
  const text = fs.readFileSync(README, 'utf8');
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  for (const block of blocks) {
    if (!block.includes('"rea"')) continue;
    try {
      return JSON.parse(block);
    } catch (e) {
      throw new Error(`JSON в README не разбирается: ${e.message}`);
    }
  }
  throw new Error('В README не найден ```json-блок с конфигурацией "rea"');
}

async function main() {
  const servers = readmeMcpConfig();
  const [name, cfg] = Object.entries(servers)[0];

  console.log(`конфиг из README: сервер "${name}"`);
  console.log(`  command: ${cfg.command}`);
  console.log(`  args:    ${JSON.stringify(cfg.args)}`);
  console.log(`  env:     ${JSON.stringify(cfg.env || {})}`);

  const problems = [];
  if (!cfg.command) problems.push('не задан command');
  if (!Array.isArray(cfg.args)) problems.push('args должен быть массивом');
  if (!fs.existsSync(cfg.command)) problems.push(`command не существует: ${cfg.command}`);
  for (const arg of cfg.args || []) {
    if (arg.endsWith('.mjs') || arg.endsWith('.js')) {
      if (!fs.existsSync(arg)) problems.push(`скрипт не найден: ${arg}`);
    }
  }
  for (const [key, value] of Object.entries(cfg.env || {})) {
    if (key === 'GHIDRA_INSTALL_DIR' && !fs.existsSync(value)) {
      problems.push(`GHIDRA_INSTALL_DIR не существует: ${value}`);
    }
  }
  if (problems.length) {
    console.error('FAIL: пример в README нерабочий:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  const mgr = new McpManager();
  const report = await mgr.connectAll(servers);
  console.log('подключение:', JSON.stringify(report));

  const defs = mgr.toolDefs;
  console.log('инструментов получено:', defs.length);
  console.log('примеры:', defs.slice(0, 3).map((t) => t.name).join(', '));

  const hasOpenBinary = defs.some((t) => t.name === `mcp__${name}__open_binary`);
  console.log('open_binary доступен:', hasOpenBinary);

  if (defs.some((t) => t.name === `mcp__${name}__binary_session`)) {
    const res = await mgr.call(`mcp__${name}__binary_session`, {});
    const open = /"open":\s*(true|false)/.exec(res);
    console.log('binary_session ответил, open =', open ? open[1] : '?', `(${res.length} символов)`);
  }

  await mgr.closeAll();

  if (!defs.length || !hasOpenBinary) {
    console.error('FAIL: сервер не отдал ожидаемые инструменты');
    process.exit(1);
  }
  console.log('ok   конфиг MCP из README рабочий');
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
