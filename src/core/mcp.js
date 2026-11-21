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

class McpManager {
  constructor() {
    this.servers = new Map(); // name -> { client, tools: [{name, description, input_schema}] }
  }

  async connect(name, cfg) {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args || [],
      env: { ...process.env, ...(cfg.env || {}) },
      cwd: cfg.cwd || process.cwd(),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'd3m3nk0', version: '0.1.0' }, { capabilities: {} });
    await client.connect(transport);
    const listed = await client.listTools();
    const tools = (listed.tools || []).map((t) => ({
      name: `mcp__${name}__${t.name}`,
      rawName: t.name,
      description: t.description || '',
      input_schema: t.inputSchema || { type: 'object', properties: {} },
    }));
    this.servers.set(name, { client, tools });
    return tools;
  }

  async connectAll(serversCfg = {}) {
    const report = [];
    for (const [name, cfg] of Object.entries(serversCfg)) {
      if (!cfg || cfg.disabled) continue;
      try {
        const tools = await this.connect(name, cfg);
        report.push({ server: name, ok: true, tools: tools.length });
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

module.exports = { McpManager };
