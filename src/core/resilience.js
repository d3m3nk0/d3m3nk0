'use strict';

/**
 * Устойчивость запросов к модели: ограничение ожидания, повтор и запасные модели.
 *
 * Бесплатные модели бывают перегружены: молчат минутами или отвечают 429.
 * runWithRetry() оборачивает один ход (runTurn) так:
 *   - нет первого байта за responseTimeoutMs → модель считается не ответившей;
 *   - поток молчит дольше idleTimeoutMs → то же;
 *   - 429 / 5xx / сбой сети → один повтор той же модели через retryDelayMs;
 *   - не помогло → следующая модель из fallbackModels.
 * Если текст или вызов инструмента уже показаны пользователю — не повторяем
 * (иначе ответ задвоится): ошибка уходит наверх как обычно. «Стоп» прерывает сразу.
 */

// Быстрые модели NVIDIA с вызовом инструментов (замер ноября 2026: 0,3–2,4 с).
const NVIDIA_FAST_MODELS = [
  'nvidia/nemotron-3.5-super-vl-120b-a12b',
  'nvidia/nemotron-3.5-lightning-30b-a3b',
  'mistralai/mistral-large-4-1t-a52b',
];

const DEFAULT_RESPONSE_MS = 60000;
const DEFAULT_IDLE_MS = 90000;
const DEFAULT_RETRY_DELAY_MS = 2000;

/** Запасные модели: из config.fallbackModels, а для NVIDIA без настройки — быстрые. */
function fallbackModels(config) {
  const own = Array.isArray(config.fallbackModels) ? config.fallbackModels : null;
  const list = own ?? (/nvidia/i.test(config.baseUrl || '') ? NVIDIA_FAST_MODELS : []);
  return [...new Set(list.filter((m) => typeof m === 'string' && m.trim() && m !== config.model))];
}

/** Вид сбоя: можно ли повторить. null — ошибка не сетевая (повтор не поможет). */
function classify(err) {
  const msg = String(err?.message || err);
  if (/API 429\b/.test(msg) || /rate.?limit|too many requests/i.test(msg)) return 'busy';
  if (/API 5\d\d\b/.test(msg)) return 'server';
  if (/Сеть недоступна|соединение оборвано|ECONNRESET|ETIMEDOUT|ECONNREFUSED|fetch failed|socket hang up/i.test(msg)) return 'network';
  return null;
}

const LABEL = {
  timeout: 'не ответила вовремя',
  busy: 'перегружена (429)',
  server: 'ошибка сервера',
  network: 'сбой сети',
};

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(t);
      reject(abortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError() {
  const e = new Error('Прервано пользователем');
  e.name = 'AbortError';
  return e;
}

/**
 * @param {object} p
 * @param {Function} p.runTurn    providers.runTurn
 * @param {object}   p.opts       параметры хода (system, messages, tools, onText…)
 * @param {object}   p.config     настройки (model, baseUrl, тайм-ауты, fallbackModels)
 * @param {AbortSignal} [p.signal] «Стоп» пользователя
 * @param {Function} [p.onInfo]   строка для пользователя: повтор, переключение
 * @returns результат runTurn + { model } — какая модель ответила
 */
async function runWithRetry({ runTurn, opts, config, signal, onInfo = () => {} }) {
  const models = [config.model, ...fallbackModels(config)];
  const firstMs = Number(config.responseTimeoutMs) > 0 ? Number(config.responseTimeoutMs) : DEFAULT_RESPONSE_MS;
  const idleMs = Number(config.idleTimeoutMs) > 0 ? Number(config.idleTimeoutMs) : DEFAULT_IDLE_MS;
  const delay = Number(config.retryDelayMs) >= 0 && config.retryDelayMs != null ? Number(config.retryDelayMs) : DEFAULT_RETRY_DELAY_MS;
  let lastErr = null;

  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) throw abortError();
      const ctl = new AbortController();
      const onUserAbort = () => ctl.abort();
      signal?.addEventListener('abort', onUserAbort, { once: true });
      let timer = null;
      let timedOut = false;
      let waitedMs = firstMs;
      const arm = (ms) => {
        clearTimeout(timer);
        waitedMs = ms;
        timer = setTimeout(() => {
          timedOut = true;
          ctl.abort();
        }, ms);
      };
      let shown = false; // текст или вызов инструмента уже ушли пользователю
      arm(firstMs);
      try {
        const res = await runTurn({
          ...opts,
          config: { ...config, model },
          signal: ctl.signal,
          onOpen: (...a) => {
            arm(idleMs);
            opts.onOpen?.(...a);
          },
          onText: (d) => {
            shown = true;
            arm(idleMs);
            opts.onText?.(d);
          },
          onReasoning: (d) => {
            arm(idleMs);
            opts.onReasoning?.(d);
          },
          onToolStart: (i) => {
            shown = true;
            arm(idleMs);
            opts.onToolStart?.(i);
          },
        });
        return { ...res, model };
      } catch (e) {
        if (signal?.aborted) throw e.name === 'AbortError' ? e : abortError(); // «Стоп»
        const kind = timedOut ? 'timeout' : classify(e);
        const err = timedOut ? new Error(`модель ${model} молчала дольше ${Math.round(waitedMs / 1000)} с`) : e;
        lastErr = err;
        if (!kind || shown) throw err;
        if (attempt === 0 && kind !== 'timeout') {
          onInfo(`${model}: ${LABEL[kind]} — повтор через ${Math.round(delay / 100) / 10} с`);
          await sleep(delay, signal);
          continue;
        }
        const next = models[mi + 1];
        if (next) onInfo(`${model}: ${LABEL[kind]} — переключаюсь на ${next}`);
        break;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onUserAbort);
      }
    }
  }
  const tried = models.join(', ');
  throw new Error(`Ни одна модель не ответила (${tried}). Последняя ошибка: ${lastErr?.message || 'нет'}`);
}

module.exports = { runWithRetry, fallbackModels, classify, NVIDIA_FAST_MODELS, DEFAULT_RESPONSE_MS };
