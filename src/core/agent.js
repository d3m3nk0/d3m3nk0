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

const fs = require('node:fs');
const path = require('node:path');
const { runTurn, estimateMessagesTokens } = require('./providers');
const { runWithRetry } = require('./resilience');
const { isAlwaysAllowed, suggestRule, sameRule } = require('./permissions');
const { isDangerous } = require('./dangerous');
const { toolSchemas, runTool } = require('./tools');
const { prepareForRequest, toolSchemaTokens } = require('./context');

const MAX_STEPS = 40;
const READ_ONLY_TOOLS = new Set(['read_file', 'list_dir', 'glob_search', 'grep_search', 'view_image', 'read_pdf']);

const RULES_FILES = ['D3M3NK0.md', 'AGENTS.md', 'CLAUDE.md'];
const RULES_MAX_CHARS = 8000; // ~2000 токенов: правила уходят в каждый запрос

/**
 * Файлы инструкций проекта в рабочей папке, в порядке приоритета.
 *
 * Своё имя первое: правила домена (сопромат, список реверс-утилит, стиль кода)
 * живут в файле проекта, а не в коде агента. Следующие два — чтобы проект можно
 * было открыть уже настроенным тем же AGENTS.md / CLAUDE.md, что и у других
 * агентов. Каталог с таким именем или нечитаемый файл просто пропускаем.
 */
function projectRuleFiles(workdir) {
  const found = [];
  for (const name of RULES_FILES) {
    try {
      const file = path.join(workdir, name);
      if (!fs.statSync(file).isFile()) continue;
      const text = fs.readFileSync(file, 'utf8').trim();
      if (text) found.push({ name, text });
    } catch {
      // файла нет или нет прав — работаем дальше без него
    }
  }
  return found;
}

/**
 * Правила проекта склеенные в порядке приоритета. Несколько файлов идут под
 * своими заголовками: если правила противоречат, модель видит, откуда какое.
 * Длиннее RULES_MAX_CHARS — обрезаем с пометкой.
 */
function loadProjectRules(workdir) {
  if (!workdir) return '';
  const found = projectRuleFiles(workdir);
  if (!found.length) return '';
  let text = found.map((f) => `## ${f.name}\n\n${f.text}`).join('\n\n');
  if (text.length > RULES_MAX_CHARS) {
    text = `${text.slice(0, RULES_MAX_CHARS)}\n[…правила обрезаны: длиннее ${RULES_MAX_CHARS} символов]`;
  }
  return text;
}

function buildSystemPrompt(config) {
  const rules = loadProjectRules(config.workdir);
  const lines = [
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
  ];
  if (rules) {
    lines.push('', 'Правила проекта из рабочей папки (выполняй их всегда):', '', rules);
  }
  return lines.join('\n');
}

/**
 * Защита от метаний в одном ходе пользователя.
 *  - maxErrors подряд неудачных вызовов (ошибка инструмента или для run_command
 *    ненулевой код выхода) → стоп;
 *  - один и тот же вызов (имя + параметры) maxRepeats раз → стоп (ходит по кругу).
 * check() возвращает причину остановки или null.
 */
class LoopGuard {
  constructor(opts = {}) {
    this.maxErrors = Number(opts?.maxErrors) > 0 ? Number(opts.maxErrors) : 3;
    this.maxRepeats = Number(opts?.maxRepeats) > 0 ? Number(opts.maxRepeats) : 3;
    this.errorStreak = 0;
    this.lastError = '';
    this.seen = new Map();
  }

  static failed(call, result) {
    if (result.is_error) return true;
    if (call.name === 'run_command') {
      const m = String(result.content || '').match(/^exit code: (-?\d+)/);
      if (m && m[1] !== '0') return true;
    }
    return false;
  }

  check(calls, results) {
    for (const call of calls) {
      // Сначала ошибки: сообщение с текстом последней ошибки полезнее, чем «по кругу».
      const result = results.find((r) => r.id === call.id);
      if (result && LoopGuard.failed(call, result)) {
        this.errorStreak += 1;
        this.lastError = `${call.name}: ${String(result.content || '').replace(/\s+/g, ' ').slice(0, 160)}`;
        if (this.errorStreak >= this.maxErrors) return `${this.errorStreak} неудачных вызова подряд (последний — ${this.lastError})`;
      } else if (result) {
        this.errorStreak = 0;
      }
      const key = `${call.name} ${JSON.stringify(call.input || {})}`;
      const n = (this.seen.get(key) || 0) + 1;
      this.seen.set(key, n);
      if (n >= this.maxRepeats) return `${call.name} вызван ${n} раза с одними и теми же параметрами — похоже, хожу по кругу`;
    }
    return null;
  }
}

/** Копия сообщения без данных картинок (для журнала сессии). */
function withoutImageData(message) {
  return {
    ...message,
    blocks: (message.blocks || []).map((b) => (b.image?.data ? { ...b, image: { ...b.image, data: undefined } } : b)),
  };
}

function needsApproval(mode, toolName, input, rules, workdir) {
  // Опасный вызов спрашивает всегда: ни yolo, ни «Разрешать всегда» его не снимают.
  if (isDangerous(toolName, input, workdir)) return true;
  if (mode === 'yolo') return false;
  if (isAlwaysAllowed(toolName, input, rules)) return false; // «Разрешать всегда»
  if (mode === 'allow-edits') return toolName === 'run_command' || toolName.startsWith('mcp__');
  // 'ask'
  if (READ_ONLY_TOOLS.has(toolName)) return false;
  return true;
}

class Agent {
  constructor({ config, session, mcp, emit, askPermission, imageResizer, imageCropper, onConfigChange }) {
    this.onConfigChange = onConfigChange || (() => {}); // сохранить правку настроек (окно — в config.json)
    this.config = config;
    this.imageResizer = imageResizer || null; // в окне — уменьшение картинок через nativeImage
    this.imageCropper = imageCropper || null; // в окне — обрезка view_image (region); в CLI нет
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

  /** Добавить правило «Разрешать всегда» и сохранить его в настройках. */
  addAlwaysRule({ rule, label }) {
    const rules = Array.isArray(this.config.alwaysAllow) ? this.config.alwaysAllow : [];
    if (rules.some((r) => sameRule(r, rule))) return;
    this.config = { ...this.config, alwaysAllow: [...rules, rule] };
    this.onConfigChange({ alwaysAllow: this.config.alwaysAllow });
    this.emit({ type: 'info', message: `Теперь без вопроса: ${label}. Отменить — Настройки → Работа и доступ.` });
  }

  /** Сменить модель на лету: история и MCP остаются, промпт пересобирается. */
  setModel(model) {
    this.config = { ...this.config, model };
    this.system = buildSystemPrompt(this.config);
  }

  /**
   * Сменить подключение (профиль провайдера) на лету: история и MCP остаются.
   * Только между запросами — посреди ответа отказ, модель не меняется на ходу.
   */
  updateConfig(next) {
    if (this.busy) throw new Error('Агент сейчас отвечает — смените профиль после ответа');
    this.config = { ...next };
    this.system = buildSystemPrompt(this.config);
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

  /**
   * Убирает начало истории, если запрос не влезает в contextBudget.
   *
   * Сообщения выбрасываются по одному с начала, пока запрос не станет ≤ 75%
   * бюджета (минимум 6 сообщений остаются). Цикл может остановиться сразу
   * после выброшенного вызова инструмента — тогда первым оказался бы его
   * результат без вызова, и API отклонил бы запрос (400). Поэтому после цикла
   * такие осиротевшие результаты тоже выбрасываются.
   */
  compactIfNeeded() {
    const budget = this.config.contextBudget || 120000;
    let est = this.requestTokens();
    if (est <= budget) return;

    const before = this.messages.length;
    let dropped = 0;
    while (this.messages.length > 6 && est > budget * 0.75) {
      this.messages.shift();
      dropped++;
      est = this.requestTokens();
    }
    // Хвост чужой пары: результаты инструментов, чей вызов только что выброшен.
    if (dropped) {
      while (this.messages.length && (this.messages[0].blocks || []).some((b) => b.type === 'tool_result')) {
        this.messages.shift();
        dropped++;
      }
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
    const guard = new LoopGuard(this.config.loopGuard);

    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        this.compactIfNeeded();
        this.emit({ type: 'turn_start', step });

        streamed = '';
        const result = await runWithRetry({
          runTurn,
          config: this.config,
          signal: sig,
          onInfo: (message) => this.emit({ type: 'info', message }),
          opts: {
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
          },
        });
        if (result.model !== this.config.model) {
          this.emit({ type: 'info', message: `Ответила запасная модель: ${result.model}` });
        }

        streamed = ''; // ответ получен целиком и сохраняется ниже
        // usage хранится в самом сообщении: после перезагрузки сессии счётчик
        // берётся из журнала и не пропадает.
        const assistantMessage = { role: 'assistant', blocks: result.blocks, ...(result.usage ? { usage: result.usage } : {}) };
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
          // Для опасного вызова «Разрешать всегда» не предлагаем: правило
          // всё равно не сработает — гейт спрашивает раньше правил.
          const danger = isDangerous(call.name, call.input, this.config.workdir);
          const suggestion = danger ? null : suggestRule(call.name, call.input);
          const answer = needsApproval(this.config.permissionMode, call.name, call.input, this.config.alwaysAllow, this.config.workdir)
            ? await this.askPermission({ id: call.id, name: call.name, input: call.input, always: suggestion?.label || null })
            : true;
          // 'always' — «Разрешать всегда»: правило запоминается и действует дальше.
          if (answer === 'always' && suggestion) this.addAlwaysRule(suggestion);
          const approved = answer === true || answer === 'always';

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
              resizeImage: this.imageResizer,
              cropImage: this.imageCropper,
            };
            output = call.name.startsWith('mcp__')
              ? await this.mcp.call(call.name, call.input)
              : await runTool(call.name, call.input || {}, ctx);
          } catch (e) {
            output = `Ошибка инструмента: ${e.message}`;
            isError = true;
          }
          // view_image возвращает { text, image }: картинка едет модели отдельным блоком.
          const image = output && typeof output === 'object' ? output.image : null;
          const text = output && typeof output === 'object' ? String(output.text ?? '') : output;
          results.push({ type: 'tool_result', id: call.id, content: text, is_error: isError, ...(image ? { image } : {}) });
          this.emit({ type: 'tool_end', id: call.id, name: call.name, ok: !isError, output: text, ...(image ? { image } : {}) });
        }

        const toolMessage = { role: 'user', blocks: results };
        this.messages.push(toolMessage);
        // В журнал — без base64: картинка остаётся на диске, в истории только путь.
        this.session?.append({ kind: 'message', message: withoutImageData(toolMessage) });

        // Защита от метаний: ошибки подряд или один и тот же вызов по кругу —
        // остановиться и спросить пользователя, а не пробовать двадцать вариантов.
        const stop = guard.check(toolUses, results);
        if (stop) {
          const note = { role: 'assistant', blocks: [{ type: 'text', text: `[Остановлено защитой от метаний: ${stop}]` }] };
          this.messages.push(note);
          this.session?.append({ kind: 'message', message: note });
          this.emit({ type: 'guard_stop', message: `Остановился: ${stop}. Подскажите, что делать дальше.` });
          break;
        }
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

module.exports = { Agent, LoopGuard, buildSystemPrompt, loadProjectRules, projectRuleFiles, needsApproval, withoutImageData, RULES_FILES, RULES_MAX_CHARS };
