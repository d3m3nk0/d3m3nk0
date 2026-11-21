'use strict';

/**
 * Агентный цикл d3m3nk0.
 *
 * Схема ровно та же, что у любого агента вида Claude Code:
 *   1. модель отвечает текстом и/или запросами инструментов;
 *   2. запросы инструментов проверяются политикой доступа;
 *   3. результаты возвращаются модели как tool_result;
 *   4. повтор, пока модель не ответит без инструментов.
 *
 * Отличия от «просто чата»: история — это протокол, а не переписка;
 * инструменты — внешние (MCP) и встроенные; каждое действие проходит гейт.
 */

const { runTurn, estimateMessagesTokens } = require('./providers');
const { toolSchemas, runTool } = require('./tools');
const { prepareForRequest, toolSchemaTokens } = require('./context');

const MAX_STEPS = 40;
const READ_ONLY_TOOLS = new Set(['read_file', 'list_dir', 'glob_search', 'grep_search']);

function buildSystemPrompt(config) {
  return [
    'Ты — d3m3nk0, десктопный агент для работы с кодом.',
    '',
    'Как работать:',
    '- Сначала пойми задачу, потом действуй. Не выдумывай содержимое файлов — читай их.',
    '- Для правок используй edit_file (точечная замена) или write_file (новая версия целиком).',
    '- После изменений проверяй результат: запускай тесты, сборку или сам скрипт через run_command.',
    '- Держи ответы короткими. Пользователь видит вывод инструментов отдельно.',
    '- Если задача неоднозначна — задай один точный вопрос вместо догадок.',
    '- Не выполняй разрушительных команд без явной просьбы.',
    '',
    'Окружение:',
    `- ОС: ${process.platform} ${process.arch}`,
    `- Рабочая папка: ${config.workdir}`,
    `- Провайдер модели: ${config.provider}, модель: ${config.model}`,
  ].join('\n');
}

function needsApproval(mode, toolName) {
  if (mode === 'yolo') return false;
  if (mode === 'allow-edits') return toolName === 'run_command' || toolName.startsWith('mcp__');
  // 'ask'
  if (READ_ONLY_TOOLS.has(toolName)) return false;
  return true;
}

class Agent {
  constructor({ config, session, mcp, emit, askPermission }) {
    this.config = config;
    this.session = session;
    this.mcp = mcp;
    this.emit = emit || (() => {});
    this.askPermission = askPermission || (async () => true);
    this.messages = [];
    this.system = buildSystemPrompt(config);
    this.busy = false;
    this.controller = null;
  }

  loadHistory(messages) {
    this.messages = messages.slice();
  }

  get history() {
    return this.messages;
  }

  /** Схемы инструментов текущего запроса: встроенные + MCP. */
  get toolDefs() {
    return toolSchemas(this.mcp?.toolDefs || []);
  }

  /** История в том виде, в каком уходит в модель: старые результаты инструментов обрезаны. */
  requestMessages() {
    return prepareForRequest(this.messages, this.config.toolResultTruncateTokens);
  }

  /** Оценка всего запроса: история (обрезанная) + системный промпт + схемы инструментов. */
  requestTokens() {
    return estimateMessagesTokens(this.requestMessages(), this.system) + toolSchemaTokens(this.toolDefs);
  }

  /** Убирает начало истории, если контекст распух. Пары tool_use/tool_result не рвём. */
  compactIfNeeded() {
    const budget = this.config.contextBudget || 120000;
    let est = this.requestTokens();
    if (est <= budget) return;

    const before = this.messages.length;
    let dropped = 0;
    while (this.messages.length > 6 && est > budget * 0.75) {
      const first = this.messages[0];
      const isSafeBoundary = first.role === 'user' && (first.blocks || []).every((b) => b.type === 'text');
      if (!isSafeBoundary) {
        // начало не на границе хода — сдвигаемся на одно сообщение, чтобы найти границу
        this.messages.shift();
        dropped++;
        est = this.requestTokens();
        continue;
      }
      this.messages.shift();
      dropped++;
      est = this.requestTokens();
    }
    if (dropped) {
      this.messages.unshift({
        role: 'user',
        blocks: [{ type: 'text', text: `[Ранняя часть разговора сокращена: убрано ${dropped} сообщений из ${before}.]` }],
      });
      this.emit({ type: 'info', message: `Контекст сокращён: убрано ${dropped} сообщений` });
    }
  }

  async send(text, { signal } = {}) {
    if (this.busy) throw new Error('Агент уже работает над предыдущим запросом');
    this.busy = true;
    this.controller = new AbortController();
    const sig = signal || this.controller.signal;

    const userMessage = { role: 'user', blocks: [{ type: 'text', text }] };
    this.messages.push(userMessage);
    this.session?.append({ kind: 'message', message: userMessage });
    this.emit({ type: 'user_message', message: userMessage });

    // Текст текущего шага, уже показанный пользователю. Живёт вне try, чтобы
    // при отмене или обрыве посреди стрима попасть в историю, а не пропасть.
    let streamed = '';

    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        this.compactIfNeeded();
        this.emit({ type: 'turn_start', step });

        streamed = '';
        const result = await runTurn({
          config: this.config,
          system: this.system,
          // В модель — копия с обрезанными старыми результатами; this.messages
          // и журнал сессии остаются полными.
          messages: this.requestMessages(),
          tools: this.toolDefs,
          signal: sig,
          onText: (delta) => {
            streamed += delta;
            this.emit({ type: 'assistant_text', text: delta });
          },
          // Модель начала вызов инструмента: имя известно, аргументы ещё идут.
          onToolStart: (info) => this.emit({ type: 'tool_call_start', ...info }),
          // Ход рассуждения — только для показа. В messages и журнал сессии не пишется.
          onReasoning: (delta) => this.emit({ type: 'assistant_reasoning', text: delta }),
          // Сервер прислал заголовки: ожидание сети кончилось, идёт генерация.
          onOpen: () => this.emit({ type: 'stream_open', step }),
        });

        streamed = ''; // ответ получен целиком и сохраняется ниже
        const assistantMessage = { role: 'assistant', blocks: result.blocks };
        this.messages.push(assistantMessage);
        this.session?.append({ kind: 'message', message: assistantMessage });
        this.emit({ type: 'assistant_message', message: assistantMessage, usage: result.usage });

        const toolUses = result.blocks.filter((b) => b.type === 'tool_use');
        if (!toolUses.length) {
          this.emit({ type: 'turn_end', usage: result.usage, stopReason: result.stopReason });
          break;
        }

        const results = [];
        for (const call of toolUses) {
          const approved = needsApproval(this.config.permissionMode, call.name)
            ? await this.askPermission({ id: call.id, name: call.name, input: call.input })
            : true;

          if (!approved) {
            const denied = { type: 'tool_result', id: call.id, content: 'Пользователь отклонил вызов инструмента.', is_error: true };
            results.push(denied);
            this.emit({ type: 'tool_end', id: call.id, name: call.name, ok: false, output: 'отклонено пользователем' });
            continue;
          }

          this.emit({ type: 'tool_start', id: call.id, name: call.name, input: call.input });
          let output = '';
          let isError = false;
          try {
            const ctx = {
              workdir: this.config.workdir,
              allowOutside: this.config.permissionMode === 'yolo',
              signal: sig,
            };
            output = call.name.startsWith('mcp__')
              ? await this.mcp.call(call.name, call.input)
              : await runTool(call.name, call.input || {}, ctx);
          } catch (e) {
            output = `Ошибка инструмента: ${e.message}`;
            isError = true;
          }
          results.push({ type: 'tool_result', id: call.id, content: output, is_error: isError });
          this.emit({ type: 'tool_end', id: call.id, name: call.name, ok: !isError, output });
        }

        const toolMessage = { role: 'user', blocks: results };
        this.messages.push(toolMessage);
        this.session?.append({ kind: 'message', message: toolMessage });
      }
    } catch (e) {
      const aborted = e.name === 'AbortError';
      if (streamed) this.savePartial(streamed, aborted ? 'прервано пользователем' : `прервано: ${e.message || e}`);
      if (aborted) this.emit({ type: 'info', message: 'Остановлено пользователем' });
      else this.emit({ type: 'error', message: String(e.message || e) });
    } finally {
      this.busy = false;
      this.controller = null;
      this.emit({ type: 'idle' });
    }
  }

  /**
   * Сохранить ответ, оборванный посреди стрима: то, что пользователь уже
   * видел, остаётся в истории и журнале сессии с пометкой о причине.
   */
  savePartial(text, reason) {
    const message = { role: 'assistant', blocks: [{ type: 'text', text: `${text}\n\n[${reason}]` }] };
    this.messages.push(message);
    this.session?.append({ kind: 'message', message });
    this.emit({ type: 'assistant_message', message, partial: true });
  }

  abort() {
    this.controller?.abort();
  }
}

module.exports = { Agent, buildSystemPrompt, needsApproval };
