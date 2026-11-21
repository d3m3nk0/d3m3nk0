'use strict';

/**
 * Провайдеры моделей.
 *
 * Внутри приложения переписка живёт в каноническом виде:
 *   { role: 'user'|'assistant', blocks: [ ... ] }
 * где блок — один из:
 *   { type: 'text', text }
 *   { type: 'tool_use', id, name, input }
 *   { type: 'tool_result', id, content, is_error }
 *
 * Адаптеры ниже переводят это в формат конкретного API и обратно.
 */

const trimSlash = (s) => String(s || '').replace(/\/+$/, '');

function safeJson(text, fallback = {}) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * Склейка Base URL и пути endpoint.
 *
 * Разные API публикуют base URL по-разному: Anthropic — без версии
 * (`https://api.anthropic.com`), OpenRouter — с версией
 * (`https://openrouter.ai/api/v1`). Если версия уже есть в base, второй раз
 * её не добавляем, иначе получится `/api/v1/v1/chat/completions` (404).
 */
function endpoint(baseUrl, path) {
  const base = trimSlash(baseUrl);
  if (/\/v\d+$/.test(base) && path.startsWith('/v1/')) return base + path.slice(3);
  return base + path;
}

async function endpointRequest(url, init) {
  try {
    return await fetch(url, init);
  } catch (e) {
    const cause = e.cause;
    const detail = cause ? cause.code || cause.message || String(cause) : e.message;
    const hint =
      detail === 'SELF_SIGNED_CERT_IN_CHAIN'
        ? ' — TLS перехватывает прокси или антивирус; запустите через npm start или с NODE_USE_SYSTEM_CA=1'
        : '';
    throw new Error(`Сеть недоступна: ${url} (${detail})${hint}`);
  }
}

async function* sseEvents(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    if (buf.includes('\r')) buf = buf.replace(/\r\n/g, '\n');
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      yield raw;
    }
  }
  if (buf.trim()) yield buf;
}

function dataLines(raw) {
  return raw
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim());
}

/* ------------------------------- Anthropic ------------------------------- */

function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    const content = [];
    for (const b of m.blocks || []) {
      if (b.type === 'text' && b.text) content.push({ type: 'text', text: b.text });
      else if (b.type === 'tool_use') content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input || {} });
      else if (b.type === 'tool_result')
        content.push({ type: 'tool_result', tool_use_id: b.id, content: b.content || '', is_error: !!b.is_error });
    }
    if (!content.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content.push(...content);
    else out.push({ role: m.role, content });
  }
  return out;
}

async function runAnthropic({ config, system, messages, tools, onText, onToolStart, signal }) {
  const body = {
    model: config.model,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    system,
    messages: toAnthropicMessages(messages),
    stream: true,
  };
  if (tools.length) body.tools = tools;

  const res = await endpointRequest(endpoint(config.baseUrl, '/v1/messages'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 800)}`);

  const blocks = [];
  let current = null;
  let usage = null;
  let stopReason = null;

  for await (const raw of sseEvents(res)) {
    for (const data of dataLines(raw)) {
      if (!data || data === '[DONE]') continue;
      let ev;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      if (ev.type === 'content_block_start') {
        const cb = ev.content_block || {};
        if (cb.type === 'tool_use') {
          current = { type: 'tool_use', id: cb.id, name: cb.name, json: '' };
          onToolStart?.({ id: cb.id, name: cb.name });
        } else {
          current = { type: 'text', text: '' };
        }
      } else if (ev.type === 'content_block_delta') {
        const d = ev.delta || {};
        if (d.type === 'text_delta' && current) {
          current.text += d.text || '';
          onText?.(d.text || '');
        } else if (d.type === 'input_json_delta' && current) {
          current.json += d.partial_json || '';
        }
      } else if (ev.type === 'content_block_stop') {
        if (current) {
          if (current.type === 'tool_use') {
            current.input = safeJson(current.json);
            delete current.json;
          }
          if (current.type === 'text' && !current.text) {
            // пустой текстовый блок не нужен
          } else {
            blocks.push(current);
          }
          current = null;
        }
      } else if (ev.type === 'message_delta') {
        if (ev.usage) usage = { ...(usage || {}), ...ev.usage };
        if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
      } else if (ev.type === 'error') {
        throw new Error(ev.error?.message || 'Ошибка потока Anthropic');
      }
    }
  }
  return { blocks, usage, stopReason };
}

/* ---------------------------- OpenAI-compatible --------------------------- */

function toOpenAIMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    const texts = (m.blocks || []).filter((b) => b.type === 'text').map((b) => b.text);
    const toolUses = (m.blocks || []).filter((b) => b.type === 'tool_use');
    const toolResults = (m.blocks || []).filter((b) => b.type === 'tool_result');

    if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: texts.join('\n') || null };
      if (toolUses.length) {
        msg.tool_calls = toolUses.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.input || {}) },
        }));
      }
      out.push(msg);
    } else {
      for (const t of toolResults) {
        out.push({ role: 'tool', tool_call_id: t.id, content: t.content || '' });
      }
      if (texts.length) out.push({ role: 'user', content: texts.join('\n') });
    }
  }
  return out;
}

function toOpenAITools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

async function runOpenAI({ config, system, messages, tools, onText, onToolStart, signal }) {
  const body = {
    model: config.model,
    messages: toOpenAIMessages(system, messages),
    temperature: config.temperature,
    max_tokens: config.maxTokens,
    stream: true,
  };
  if (tools.length) body.tools = toOpenAITools(tools);

  const res = await endpointRequest(endpoint(config.baseUrl, '/v1/chat/completions'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`OpenAI-совместимый API ${res.status}: ${(await res.text()).slice(0, 800)}`);

  let text = '';
  const calls = new Map(); // index -> { id, name, args }
  let usage = null;
  let stopReason = null;

  for await (const raw of sseEvents(res)) {
    for (const data of dataLines(raw)) {
      if (!data || data === '[DONE]') continue;
      let ev;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      if (ev.usage) usage = ev.usage;
      const choice = (ev.choices || [])[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (delta.content) {
        text += delta.content;
        onText?.(delta.content);
      }
      for (const tc of delta.tool_calls || []) {
        const idx = tc.index ?? 0;
        if (!calls.has(idx)) {
          calls.set(idx, { id: tc.id || `call_${idx}`, name: tc.function?.name || '', args: '' });
          if (tc.function?.name) onToolStart?.({ id: calls.get(idx).id, name: tc.function.name });
        }
        const cur = calls.get(idx);
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
      }
      if (choice.finish_reason) stopReason = choice.finish_reason;
    }
  }

  const blocks = [];
  if (text) blocks.push({ type: 'text', text });
  for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
    if (!c.name) continue;
    blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: safeJson(c.args) });
  }
  return { blocks, usage, stopReason };
}

/* --------------------------------- Dispatcher ----------------------------- */

async function runTurn(opts) {
  if (opts.config.provider === 'openai') return runOpenAI(opts);
  return runAnthropic(opts);
}

function estimateTokens(text) {
  return Math.ceil(String(text).length / 4);
}

function estimateMessagesTokens(messages, system) {
  let n = estimateTokens(system || '');
  for (const m of messages) {
    for (const b of m.blocks || []) {
      if (b.type === 'text') n += estimateTokens(b.text);
      else if (b.type === 'tool_use') n += estimateTokens(JSON.stringify(b.input || {})) + 20;
      else if (b.type === 'tool_result') n += estimateTokens(b.content || '') + 10;
    }
  }
  return n;
}

module.exports = { runTurn, endpoint, estimateTokens, estimateMessagesTokens };
