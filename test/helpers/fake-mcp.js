'use strict';

/**
 * Минимальный MCP-сервер (stdio) для регрессионных тестов: один инструмент ping.
 *
 * Нужен не ради инструмента, а ради живого дочернего процесса. Настоящий MCP
 * (REA) держит процесс CLI, пока открыт его канал. Без такого процесса
 * зависший rl.question() незаметен — Node выходит сам, и тест на Ctrl+C
 * в покое прошёл бы даже со старой ошибкой.
 *
 *   node test/helpers/fake-mcp.js
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const server = new Server({ name: 'fake-mcp', version: '0.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'ping', description: 'Ответить pong', inputSchema: { type: 'object', properties: {} } }],
}));

server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'pong' }] }));

server.connect(new StdioServerTransport());
