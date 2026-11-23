'use strict';

/**
 * MCP-клиент: подключает внешние серверы инструментов по stdio.
 *
 * Это тот же протокол, что использует Claude Code: агент не знает заранее,
 * какие инструменты существуют, — он спрашивает у сервера список и вызывает их.
 *
 * Имена инструментов префиксуются: mcp__<server>__<tool>.
 */

const path = require('node:path');
// Версия клиента для MCP-серверов — та же, что у приложения: только в package.json.
const { version: APP_VERSION } = require('../../package.json');

// Сколько ждать, пока сервер запустится и отдаст список инструментов.
// REA с Ghidra стартует за секунды; 45 с — с большим запасом.
const STARTUP_TIMEOUT_MS = 45000;

class McpManager {
  constructor() {
    this.servers = new Map(); // name -> { client, tools: [{name, description, input_schema}] }
  }

  /** Закрыть и забыть сервер, если он подключён. Ошибки закрытия не важны. */
  async disconnect(name) {
    const old = this.servers.get(name);
    if (!old) return;
    this.servers.delete(name);
    try {
      await old.client.close();
    } catch {
      // сервер мог уже умереть
    }
  }

  async connect(name, cfg) {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    // Повторное подключение под тем же именем не должно оставлять старый
    // процесс без ссылки: closeAll() его бы уже не нашёл.
    await this.disconnect(name);

    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args || [],
      env: { ...process.env, ...(cfg.env || {}) },
      cwd: cfg.cwd || process.cwd(),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'd3m3nk0', version: APP_VERSION }, { capabilities: {} });
    // Сервер, который запустился и молчит, иначе держал бы сборку агента вечно:
    // окно ждало бы «Сохранить» без конца. Предел — startupTimeoutMs в конфиге.
    const limitMs = Number(cfg.startupTimeoutMs) > 0 ? Number(cfg.startupTimeoutMs) : STARTUP_TIMEOUT_MS;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`не ответил за ${Math.round(limitMs / 1000)} с (проверьте команду запуска)`)),
        limitMs,
      );
    });
    let listed;
    try {
      listed = await Promise.race([
        (async () => {
          await client.connect(transport);
          return client.listTools();
        })(),
        timeout,
      ]);
    } catch (e) {
      // Процесс сервера мог уже запуститься. В servers он ещё не попал,
      // поэтому closeAll() о нём не узнает — закрываем здесь.
      await client.close().catch(() => {});
      throw e;
    } finally {
      clearTimeout(timer);
    }

    // Сервер может отдавать сотни инструментов, а они уходят в каждый запрос
    // к модели и съедают контекст (у REA это ~82 000 токенов на 263 схемы).
    // Поэтому набор можно ограничить: tools — белый список, exclude — чёрный.
    const allow = Array.isArray(cfg.tools) && cfg.tools.length ? new Set(cfg.tools) : null;
    const deny = new Set(cfg.exclude || []);

    const tools = (listed.tools || [])
      .filter((t) => (!allow || allow.has(t.name)) && !deny.has(t.name))
      .map((t) => ({
        name: `mcp__${name}__${t.name}`,
        rawName: t.name,
        description: t.description || '',
        input_schema: t.inputSchema || { type: 'object', properties: {} },
      }));
    this.servers.set(name, { client, tools, total: (listed.tools || []).length });
    return tools;
  }

  async connectAll(serversCfg = {}) {
    const report = [];
    for (const [name, cfg] of Object.entries(serversCfg)) {
      if (!cfg || cfg.disabled) continue;
      try {
        const tools = await this.connect(name, cfg);
        const total = this.servers.get(name)?.total ?? tools.length;
        const chars = JSON.stringify(tools).length;
        report.push({ server: name, ok: true, tools: tools.length, total, chars });
      } catch (e) {
        report.push({ server: name, ok: false, error: String(e.message || e) });
      }
    }
    return report;
  }

  get toolDefs() {
    const out = [];
    for (const [, s] of this.servers) out.push(...s.tools);
    return out;
  }

  get status() {
    return [...this.servers.entries()].map(([name, s]) => ({ name, tools: s.tools.length }));
  }

  async call(fullName, input) {
    const [, serverName, ...rest] = fullName.split('__');
    const toolName = rest.join('__');
    const entry = this.servers.get(serverName);
    if (!entry) throw new Error(`MCP-сервер не подключён: ${serverName}`);
    const res = await entry.client.callTool({ name: toolName, arguments: input || {} });
    const parts = (res.content || [])
      .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
      .filter(Boolean);
    const text = parts.join('\n') || '(пустой ответ)';
    if (res.isError) throw new Error(text);
    return text;
  }

  async closeAll() {
    for (const [, s] of this.servers) {
      try {
        await s.client.close();
      } catch {
        // сервер мог уже умереть — это не повод падать
      }
    }
    this.servers.clear();
  }
}

/**
 * Сводка плагинов для окна настроек: каждый сервер из конфига и его
 * состояние по последнему отчёту connectAll().
 *   state: 'off' (выключен) | 'ok' (подключён) | 'error' | 'pending' (ещё не подключали)
 */
function describePlugins(serversCfg = {}, report = []) {
  const byName = new Map(report.map((r) => [r.server, r]));
  return Object.entries(serversCfg).map(([name, cfg]) => {
    const c = cfg || {};
    const r = byName.get(name);
    const base = {
      name,
      enabled: !c.disabled,
      command: c.command || '',
      filtered: Array.isArray(c.tools) && c.tools.length ? c.tools.length : null,
    };
    if (c.disabled) return { ...base, state: 'off' };
    if (!r) return { ...base, state: 'pending' };
    if (!r.ok) return { ...base, state: 'error', error: r.error };
    return { ...base, state: 'ok', tools: r.tools, total: r.total };
  });
}

module.exports = { McpManager, describePlugins };
