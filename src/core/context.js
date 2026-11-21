'use strict';

/**
 * Что из истории реально уходит в модель.
 *
 * Замер (scripts/session-tokens.js) показал: ~93% токенов длинной сессии —
 * результаты инструментов. Поэтому перед отправкой старые результаты
 * обрезаются, а журнал сессии и this.messages агента остаются полными.
 *
 * Правило одно на агента и на скрипт замера — оно живёт только здесь.
 */

const { estimateTokens } = require('./providers');

const CHARS_PER_TOKEN = 4; // та же единица, что в estimateTokens
const HEAD_TOKENS = 200; // сколько оставить с начала результата
const TAIL_TOKENS = 100; // и с конца: там бывают итоги, ошибки, последние строки

/**
 * Обрезать текст результата, если он длиннее limit токенов:
 * начало + пометка + конец. Короткий текст возвращается как есть.
 */
function truncateToolResult(text, limit) {
  const s = String(text ?? '');
  if (!limit || estimateTokens(s) <= Math.max(limit, HEAD_TOKENS + TAIL_TOKENS)) return s;
  const headEnd = HEAD_TOKENS * CHARS_PER_TOKEN;
  const tailStart = s.length - TAIL_TOKENS * CHARS_PER_TOKEN;
  const cut = estimateTokens(s.slice(headEnd, tailStart));
  // Пометка явно говорит, что пропущена середина, а конец настоящий: прежний
  // текст «обрезано: ещё N» модель читала как обрыв вывода в конце.
  return `${s.slice(0, headEnd)}\n[…пропущено ~${cut} токенов из середины вывода; ниже приведён его конец…]\n${s.slice(tailStart)}`;
}

/** Индекс последнего сообщения пользователя с текстом (а не с результатами инструментов). */
function lastUserTurnIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && (m.blocks || []).some((b) => b.type === 'text')) return i;
  }
  return -1;
}

/**
 * Копия истории для отправки в модель. Результаты инструментов прошлых ходов
 * (до последнего сообщения пользователя) обрезаются; всё, что получено в
 * текущем ходе, уходит целиком — иначе модель не смогла бы прочитать
 * только что запрошенный файл. Исходный массив не меняется.
 */
function prepareForRequest(messages, limit) {
  if (!limit) return messages;
  const boundary = lastUserTurnIndex(messages);
  return messages.map((m, i) => {
    if (i >= boundary || m.role !== 'user') return m;
    let changed = false;
    const blocks = (m.blocks || []).map((b) => {
      if (b.type !== 'tool_result') return b;
      const content = truncateToolResult(b.content, limit);
      if (content === b.content) return b;
      changed = true;
      return { ...b, content };
    });
    return changed ? { ...m, blocks } : m;
  });
}

/** Токены схем инструментов (встроенные + MCP), которые уходят в каждый запрос. */
function toolSchemaTokens(schemas) {
  return estimateTokens(JSON.stringify(schemas || []));
}

module.exports = { truncateToolResult, prepareForRequest, lastUserTurnIndex, toolSchemaTokens, HEAD_TOKENS, TAIL_TOKENS };
