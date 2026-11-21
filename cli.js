'use strict';

/**
 * CLI-режим: тот же агент без Electron. Удобно для отладки ядра
 * и для работы на машинах без графической оболочки.
 *
 *   node cli.js                 интерактивно
 *   node cli.js "задача"        один запрос и выход
 */

const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { loadConfig } = require('./src/core/config');
const { Session } = require('./src/core/session');
const { McpManager } = require('./src/core/mcp');
const { Agent } = require('./src/core/agent');

async function main() {
  const config = loadConfig();
  const mcp = new McpManager();
  const session = new Session();
  const rl = readline.createInterface({ input: stdin, output: stdout });

  const report = await mcp.connectAll(config.mcpServers);
  for (const r of report) {
    if (!r.ok) {
      console.log(`MCP ${r.server}: ошибка — ${r.error}`);
      continue;
    }
    const kTokens = Math.ceil(r.chars / 4 / 1000);
    console.log(`MCP ${r.server}: ${r.tools} из ${r.total} инструментов (~${kTokens}k токенов)`);
  }

  let printing = false;
  const emit = (ev) => {
    if (ev.type === 'assistant_text') {
      printing = true;
      stdout.write(ev.text);
    } else if (ev.type === 'assistant_message') {
      if (printing) stdout.write('\n');
      printing = false;
    } else if (ev.type === 'tool_start') {
      console.log(`\n→ ${ev.name} ${JSON.stringify(ev.input)}`);
    } else if (ev.type === 'tool_end') {
      console.log(`${ev.ok ? '✓' : '✗'} ${ev.name}: ${ev.output.split('\n')[0].slice(0, 120)}`);
    } else if (ev.type === 'error') {
      console.error(`\nОшибка: ${ev.message}`);
    }
  };

  const askPermission = async ({ name, input }) => {
    const ans = await rl.question(`\nРазрешить ${name} ${JSON.stringify(input).slice(0, 200)}? [y/N] `);
    return /^y/i.test(ans.trim());
  };

  const agent = new Agent({ config, session, mcp, emit, askPermission });
  console.log(`d3m3nk0 · ${config.provider}/${config.model} · ${config.workdir}`);
  console.log(`Сессия: ${session.id}\n`);

  const once = process.argv.slice(2).join(' ').trim();
  if (once) {
    await agent.send(once);
    await mcp.closeAll();
    rl.close();
    return;
  }

  for (;;) {
    let line;
    try {
      line = await rl.question('› ');
    } catch {
      break;
    }
    const text = line.trim();
    if (!text) continue;
    if (text === '/exit' || text === '/quit') break;
    if (text === '/new') {
      agent.loadHistory([]);
      console.log('История очищена');
      continue;
    }
    await agent.send(text);
    console.log('');
  }

  await mcp.closeAll();
  rl.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
