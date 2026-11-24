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

const HEAD_TOKENS = 200; // сколько оставить с начала результата
const TAIL_TOKENS = 100; // и с конца: там бывают итоги, ошибки, последние строки

/**
 * Обрезать текст результата, если он длиннее limit токенов:
 * начало + пометка + конец. Короткий текст возвращается как есть.
 */
function truncateToolResult(text, limit) {
  const s = String(text ?? '');
  const tokens = estimateTokens(s);
  if (!limit || tokens <= Math.max(limit, HEAD_TOKENS + TAIL_TOKENS)) return s;
  // Ширина символа в токенах зависит от языка, поэтому берём её из той же
  // оценки, а не из жёсткого «4»: иначе для кириллицы «200 токенов» начала
  // весили бы вдвое больше, чем предполагает limit.
  const charsPerToken = s.length / tokens;
  const headEnd = Math.round(HEAD_TOKENS * charsPerToken);
  const tailStart = s.length - Math.round(TAIL_TOKENS * charsPerToken);
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
 *
 * Картинки (view_image) из прошлых ходов не отправляются вовсе — даже при
 * limit 0: иначе каждая открытая картинка ехала бы в каждом запросе. Вместо
 * неё модель видит пометку и может открыть картинку снова.
 */
function prepareForRequest(messages, limit) {
  const boundary = lastUserTurnIndex(messages);
  return messages.map((m, i) => {
    if (i >= boundary || m.role !== 'user') return m;
    let changed = false;
    const blocks = (m.blocks || []).map((b) => {
      if (b.type !== 'tool_result') return b;
      let next = b;
      if (b.image?.data) {
        next = {
          ...b,
          image: { ...b.image, data: undefined },
          content: `${b.content || ''}\n${pastImageNote(b.image.path)}`,
        };
      }
      if (limit) {
        const content = truncateToolResult(next.content, limit);
        if (content !== next.content) next = { ...next, content };
      }
      if (next !== b) changed = true;
      return next;
    });
    return changed ? { ...m, blocks } : m;
  });
}

function pastImageNote(p) {
  return `[картинка ${p} была показана в прошлом ходе; чтобы посмотреть снова — вызови view_image]`;
}

/** Токены схем инструментов (встроенные + MCP), которые уходят в каждый запрос. */
function toolSchemaTokens(schemas) {
  return estimateTokens(JSON.stringify(schemas || []));
}

module.exports = { truncateToolResult, prepareForRequest, lastUserTurnIndex, toolSchemaTokens, pastImageNote, HEAD_TOKENS, TAIL_TOKENS };
