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
    // Отмена (Стоп / Ctrl+C) — не сетевой сбой: пробрасываем как есть, чтобы
    // агент показал «[прервано пользователем]», а не «Сеть недоступна».
    if (e.name === 'AbortError' || init?.signal?.aborted) throw e;
    const cause = e.cause;
    const detail = cause ? cause.code || cause.message || String(cause) : e.message;
    // Опечатка в Base URL — не «нет сети»: fetch даже не пробовал соединиться.
    if (/Failed to parse URL|Invalid URL/i.test(e.message) || cause?.code === 'ERR_INVALID_URL') {
      throw new Error(`Неверный адрес сервера: ${url} — проверьте Base URL в настройках или профиле`);
    }
    const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(url);
    const hint =
      detail === 'SELF_SIGNED_CERT_IN_CHAIN'
        ? ' — TLS перехватывает прокси или антивирус; запустите через npm start или с NODE_USE_SYSTEM_CA=1'
        : local && detail === 'ECONNREFUSED'
          ? ' — сервер модели на этом компьютере не запущен?'
          : '';
    throw new Error(`Сеть недоступна: ${url} (${detail})${hint}`);
  }
}

async function* sseEvents(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let complete = false;
  try {
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
    complete = true;
  } catch (e) {
    if (e.name === 'AbortError') throw e; // «Стоп» пользователя — не обрыв
    throw new Error(`соединение оборвано посреди ответа (${e.message})`);
  } finally {
    // Потребитель вышел раньше (например, после [DONE]) — закрываем соединение.
    if (!complete) reader.cancel().catch(() => {});
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
      else if (b.type === 'tool_result') {
        // Anthropic принимает картинку прямо внутри tool_result.
        const inner = b.image?.data
          ? [
              { type: 'text', text: b.content || '' },
              { type: 'image', source: { type: 'base64', media_type: b.image.media_type, data: b.image.data } },
            ]
          : b.content || '';
        content.push({ type: 'tool_result', tool_use_id: b.id, content: inner, is_error: !!b.is_error });
      }
    }
    if (!content.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content.push(...content);
    else out.push({ role: m.role, content });
  }
  return out;
}

async function runAnthropic({ config, system, messages, tools, onText, onToolStart, onReasoning, onOpen, signal }) {
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
      ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 800)}`);
  onOpen?.();

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
      if (ev.type === 'message_start') {
        // Вход и кэш приходят один раз в начале ответа, выход — в message_delta.
        if (ev.message?.usage) usage = { ...(usage || {}), ...ev.message.usage };
      } else if (ev.type === 'content_block_start') {
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
        } else if (d.type === 'thinking_delta' && d.thinking) {
          onReasoning?.(d.thinking); // только для показа, в блоки ответа не попадает
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
      // В OpenAI-формате ответ инструмента — только текст. Картинки идут
      // следующим сообщением пользователя: так понимают почти все провайдеры.
      const images = toolResults.filter((t) => t.image?.data);
      if (images.length) {
        const parts = [
          {
            type: 'text',
            text: `[Не сообщение пользователя: это изображение файлов, которые ты открыл через view_image: ${images.map((t) => t.image.path).join(', ')}]`,
          },
        ];
        for (const t of images) parts.push({ type: 'image_url', image_url: { url: `data:${t.image.media_type};base64,${t.image.data}` } });
        if (texts.length) parts.push({ type: 'text', text: texts.join('\n') });
        out.push({ role: 'user', content: parts });
      } else if (texts.length) out.push({ role: 'user', content: texts.join('\n') });
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

async function runOpenAI({ config, system, messages, tools, onText, onToolStart, onReasoning, onOpen, signal }) {
  const body = {
    model: config.model,
    messages: toOpenAIMessages(system, messages),
    temperature: config.temperature,
    max_tokens: config.maxTokens,
    stream: true,
    // usage в стриме приходит только с этим флагом: без него DeepSeek и
    // OpenRouter отдают пустой объект, и счётчик в окне показывал бы прочерк.
    stream_options: { include_usage: true },
  };
  if (tools.length) body.tools = toOpenAITools(tools);

  const url = endpoint(config.baseUrl, '/v1/chat/completions');
  const request = (payload) =>
    endpointRequest(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Пустой ключ — заголовка нет вовсе: локальные серверы (Ollama и т.п.)
        // ключ не ждут, а «Bearer » без значения некоторые из них отвергают.
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      signal,
    });

  let res = await request(body);
  if (!res.ok) {
    const status = res.status;
    const errText = await res.text();
    const retriable = status === 400 || status === 422;
    if (retriable && /stream_options|include_usage/i.test(errText)) {
      // Сервер не знает флаг счётчика: работаем без usage, но со стримингом.
      // Проверяем это раньше общего /stream/, иначе потеряли бы и стриминг.
      const { stream_options: _drop, ...plain } = body;
      res = await request(plain);
    } else if (retriable && /stream/i.test(errText)) {
      // Сервер без стриминга: повторяем тот же запрос обычным ответом.
      res = await request({ ...body, stream: false, stream_options: undefined });
    } else {
      // 404 про модель (у Ollama — «model … not found»): подсказать, что поправить.
      const hint = status === 404 && /model/i.test(errText) ? ` — модель «${config.model}» не найдена на сервере, проверьте название` : '';
      throw new Error(`OpenAI-совместимый API ${status}${hint}: ${errText.slice(0, 800)}`);
    }
    if (!res.ok) throw new Error(`OpenAI-совместимый API ${res.status}: ${(await res.text()).slice(0, 800)}`);
  }

  onOpen?.(); // сервер ответил — дальше ждём уже не сеть, а генерацию

  // Ответ целиком (stream проигнорирован или выключен) — разбираем как обычный JSON.
  if (!/text\/event-stream/i.test(res.headers.get('content-type') || '')) {
    return openAIWhole(await res.text(), onText, onToolStart, onReasoning);
  }

  let text = '';
  const calls = new Map(); // index -> { id, name, args }
  let usage = null;
  let stopReason = null;

  let finished = false;
  for await (const raw of sseEvents(res)) {
    for (const data of dataLines(raw)) {
      if (data === '[DONE]') {
        finished = true;
        break;
      }
      if (!data) continue;
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
      // Ход рассуждения (NVIDIA Nemotron, DeepSeek и др.): только для показа,
      // в text и историю не попадает.
      const reasoning = delta.reasoning_content || delta.reasoning;
      if (reasoning) onReasoning?.(reasoning);
      if (delta.content) {
        text += delta.content;
        onText?.(delta.content);
      }
      for (const tc of delta.tool_calls || []) {
        const idx = tc.index ?? 0;
        if (!calls.has(idx)) calls.set(idx, { id: tc.id || `call_${idx}`, name: '', args: '', announced: false });
        const cur = calls.get(idx);
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        // Имя может прийти не в первом чанке вызова — объявляем, как только оно известно.
        if (cur.name && !cur.announced) {
          cur.announced = true;
          onToolStart?.({ id: cur.id, name: cur.name });
        }
      }
      if (choice.finish_reason) stopReason = choice.finish_reason;
    }
    if (finished) break; // после [DONE] не ждём, пока сервер закроет соединение
  }

  const blocks = [];
  if (text) blocks.push({ type: 'text', text });
  for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
    if (!c.name) continue;
    blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: safeJson(c.args) });
  }
  return { blocks, usage, stopReason };
}

/** Обычный (не потоковый) ответ chat/completions в канонические блоки. */
function openAIWhole(raw, onText, onToolStart, onReasoning) {
  const data = safeJson(raw, null);
  const choice = data?.choices?.[0];
  if (!choice) throw new Error(`OpenAI-совместимый API: неожиданный ответ: ${String(raw).slice(0, 300)}`);
  const msg = choice.message || {};
  const reasoning = msg.reasoning_content || msg.reasoning;
  if (reasoning) onReasoning?.(reasoning);
  const blocks = [];
  if (msg.content) {
    blocks.push({ type: 'text', text: msg.content });
    onText?.(msg.content);
  }
  for (const [i, tc] of (msg.tool_calls || []).entries()) {
    if (!tc.function?.name) continue;
    const id = tc.id || `call_${i}`;
    onToolStart?.({ id, name: tc.function.name });
    blocks.push({ type: 'tool_use', id, name: tc.function.name, input: safeJson(tc.function.arguments) });
  }
  return { blocks, usage: data.usage || null, stopReason: choice.finish_reason || null };
}

/* --------------------------------- Dispatcher ----------------------------- */

/**
 * Привести usage провайдера к одному виду: { input, output, cacheRead, cacheWrite }.
 * null — провайдер ничего не прислал; окно и CLI покажут прочерк, а не упадут.
 *
 * Разница, которую нельзя замазать: у Anthropic input_tokens — только
 * некэшированная часть, кэш приходит отдельными полями. У OpenAI наоборот,
 * prompt_tokens включает всё, а прочитанное из кэша лежит в
 * prompt_tokens_details.cached_tokens.
 */
function normalizeUsage(provider, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  if (provider === 'openai') {
    const input = num(raw.prompt_tokens);
    const output = num(raw.completion_tokens);
    const cacheRead = num(raw.prompt_tokens_details?.cached_tokens);
    if (!input && !output && !cacheRead) return null;
    return { input, output, cacheRead, cacheWrite: 0 };
  }

  const input = num(raw.input_tokens);
  const output = num(raw.output_tokens);
  const cacheRead = num(raw.cache_read_input_tokens);
  const cacheWrite = num(raw.cache_creation_input_tokens);
  if (!input && !output && !cacheRead && !cacheWrite) return null;
  return { input, output, cacheRead, cacheWrite };
}

async function runTurn(opts) {
  const provider = opts.config.provider === 'openai' ? 'openai' : 'anthropic';
  const res = provider === 'openai' ? await runOpenAI(opts) : await runAnthropic(opts);
  // Один вид usage для агента, окна, CLI и тестов — независимо от провайдера.
  return { ...res, usage: normalizeUsage(provider, res.usage) };
}

// Картинку модель считает не по длине base64, а по пикселям:
// до 1600 px это порядка полутора-двух тысяч токенов.
const IMAGE_TOKENS = 1600;

// Токенизаторы режут латиницу примерно на 4 символа за токен, а кириллицу —
// вдвое плотнее, около 2 символов. Поэтому оценка зависит от доли не-ASCII:
// если она больше 30%, считаем символы / 2, иначе символы / 4.
const NON_ASCII_SHARE = 0.3;
const ASCII_CHARS_PER_TOKEN = 4;
const WIDE_CHARS_PER_TOKEN = 2;

function estimateTokens(text) {
  const s = String(text);
  if (!s.length) return 0;
  let nonAscii = 0;
  // Считаем по code units — той же единице, в которой измеряется s.length.
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) nonAscii++;
  const charsPerToken = nonAscii / s.length > NON_ASCII_SHARE ? WIDE_CHARS_PER_TOKEN : ASCII_CHARS_PER_TOKEN;
  return Math.ceil(s.length / charsPerToken);
}

function estimateMessagesTokens(messages, system) {
  let n = estimateTokens(system || '');
  for (const m of messages) {
    for (const b of m.blocks || []) {
      if (b.type === 'text') n += estimateTokens(b.text);
      else if (b.type === 'tool_use') n += estimateTokens(JSON.stringify(b.input || {})) + 20;
      else if (b.type === 'tool_result') n += estimateTokens(b.content || '') + 10 + (b.image?.data ? IMAGE_TOKENS : 0);
    }
  }
  return n;
}

module.exports = { runTurn, endpoint, estimateTokens, estimateMessagesTokens, toOpenAIMessages, toAnthropicMessages, normalizeUsage, IMAGE_TOKENS };
