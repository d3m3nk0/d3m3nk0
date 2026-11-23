'use strict';

/**
 * Профили провайдеров (Пункт 11): несколько готовых подключений — например,
 * локальная модель (Ollama на localhost) и бесплатный API с ключом — и выбор
 * активного в настройках окна.
 *
 * В config.json:
 *   profiles: [{ id, name, provider, baseUrl, model, apiKey }]
 *   activeProfile: id | null   (null — обычные поля «Модель и ключ»)
 *
 * Профиль НАКЛАДЫВАЕТСЯ поверх обычных настроек (effectiveConfig), а не
 * перетирает их: «Без профиля» возвращает прежнее подключение.
 *
 * Правила:
 *  - названия моделей и провайдеров в коде не зашиты: только то, что ввёл
 *    пользователь, и список моделей, который отдал сам сервер;
 *  - пустой ключ — заголовок Authorization не отправляется (providers.js);
 *  - с активным профилем автопереключения на запасные модели нет;
 *  - ключи в окно не уходят: maskProfiles() заменяет их на hasKey.
 */

const { endpoint } = require('./providers');

const PROVIDERS = new Set(['openai', 'anthropic']);
const NAME_MAX = 60;
const PROBE_TIMEOUT_MS = 5000;

function newId() {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Проверить адрес: только http(s). Возвращает адрес без хвостового «/». */
function checkBaseUrl(raw) {
  const s = String(raw ?? '').trim();
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`Неверный адрес сервера: «${s || 'пусто'}». Пример: http://localhost:11434/v1`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Адрес сервера должен начинаться с http:// или https:// — сейчас «${s}»`);
  }
  return s.replace(/\/+$/, '');
}

/**
 * Привести введённый профиль к виду для config.json. Ошибка — понятным текстом.
 * existing — уже сохранённый профиль с тем же id (для правки).
 */
function normalizeProfile(raw, existing = null) {
  const name = String(raw?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  if (!name) throw new Error('Укажите имя профиля');
  const provider = String(raw?.provider || 'openai');
  if (!PROVIDERS.has(provider)) throw new Error(`Неизвестный тип провайдера: ${provider}`);
  const baseUrl = checkBaseUrl(raw?.baseUrl);
  const model = String(raw?.model ?? '').trim();
  if (!model) throw new Error('Укажите модель (так, как её называет сервер)');
  const apiKey = String(raw?.apiKey ?? '').trim();
  return { id: existing?.id || raw?.id || newId(), name, provider, baseUrl, model, apiKey };
}

function findProfile(config, id) {
  return (Array.isArray(config.profiles) ? config.profiles : []).find((p) => p && p.id === id) || null;
}

/**
 * Настройки, по которым реально идут запросы: активный профиль поверх обычных.
 * С профилем запасных моделей нет — только ручной выбор.
 */
function effectiveConfig(config) {
  const p = config.activeProfile ? findProfile(config, config.activeProfile) : null;
  if (!p) return { ...config, activeProfileName: null };
  return {
    ...config,
    provider: p.provider,
    baseUrl: p.baseUrl,
    model: p.model,
    apiKey: p.apiKey || '',
    fallbackModels: [],
    activeProfileName: p.name,
  };
}

/** Профили для окна: без ключей, только признак «ключ задан». */
function maskProfiles(profiles) {
  return (Array.isArray(profiles) ? profiles : []).map(({ apiKey, ...rest }) => ({ ...rest, hasKey: !!apiKey }));
}

/**
 * Проверить профиль перед включением: GET <baseUrl>/v1/models.
 *   ok: false — сервер не отвечает, адрес неверный, ключ отклонён, модели нет;
 *   ok: true, warning — сервер отвечает, но список моделей не отдаёт.
 * Не дольше PROBE_TIMEOUT_MS: выбор профиля не должен вешать окно.
 */
async function probeProfile(profile, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  let url;
  try {
    url = endpoint(checkBaseUrl(profile.baseUrl), '/v1/models');
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const headers = {};
  if (profile.apiKey) {
    if (profile.provider === 'anthropic') {
      headers['x-api-key'] = profile.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else headers.authorization = `Bearer ${profile.apiKey}`;
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { headers, signal: ctl.signal });
  } catch (e) {
    if (ctl.signal.aborted) return { ok: false, error: `Сервер ${profile.baseUrl} не ответил за ${Math.round(timeoutMs / 1000)} с` };
    const detail = e.cause?.code || e.cause?.message || e.message;
    const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(profile.baseUrl);
    return {
      ok: false,
      error: `Сервер не отвечает: ${profile.baseUrl} (${detail})${local ? ' — программа модели на этом компьютере запущена?' : ''}`,
    };
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) return { ok: false, error: `Сервер отклонил ключ (${res.status}) — проверьте ключ в профиле` };
  if (res.status === 404 || res.status === 405) {
    return { ok: true, warning: 'Сервер не отдаёт список моделей — название модели не проверено' };
  }
  if (!res.ok) return { ok: false, error: `Сервер ответил ${res.status} на проверку: ${(await res.text()).slice(0, 200)}` };
  let ids = [];
  try {
    const data = await res.json();
    ids = (Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [])
      .map((m) => m?.id || m?.name)
      .filter((x) => typeof x === 'string');
  } catch {
    return { ok: true, warning: 'Сервер ответил, но список моделей не разобран — название модели не проверено' };
  }
  if (ids.length && !ids.includes(profile.model)) {
    const shown = ids.slice(0, 10).join(', ') + (ids.length > 10 ? ` и ещё ${ids.length - 10}` : '');
    return { ok: false, error: `Модель «${profile.model}» не найдена на сервере. Есть: ${shown}` };
  }
  return { ok: true, models: ids.length };
}

module.exports = { normalizeProfile, effectiveConfig, maskProfiles, probeProfile, findProfile, checkBaseUrl, PROBE_TIMEOUT_MS };
