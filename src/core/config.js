'use strict';

/**
 * Настройки d3m3nk0.
 *
 * Хранятся в ~/.d3m3nk0/config.json (или в D3M3NK0_HOME).
 * Ключ API в репозиторий не попадает: файл лежит вне проекта.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME = process.env.D3M3NK0_HOME || path.join(os.homedir(), '.d3m3nk0');
const CONFIG_FILE = path.join(HOME, 'config.json');
const SESSIONS_DIR = path.join(HOME, 'sessions');

const DEFAULTS = {
  provider: 'anthropic', // 'anthropic' | 'openai' (любой OpenAI-совместимый endpoint)
  model: 'claude-sonnet-4-5',
  baseUrl: 'https://api.anthropic.com',
  apiKey: '',
  maxTokens: 8192,
  temperature: 0,
  workdir: process.cwd(),
  permissionMode: 'ask', // 'ask' | 'allow-edits' | 'yolo'
  contextBudget: 120000, // примерный лимит токенов запроса: история + промпт + схемы инструментов
  // Результаты инструментов прошлых ходов длиннее порога уходят в модель
  // обрезанными (начало + конец). Журнал сессии хранит их полностью. 0 — не резать.
  toolResultTruncateTokens: 400,
  mcpServers: {},
  // Устойчивость (resilience.js): сколько ждать первого ответа и тишины в потоке,
  // пауза перед повтором; запасные модели (null — для NVIDIA быстрые по умолчанию).
  responseTimeoutMs: 60000,
  idleTimeoutMs: 90000,
  retryDelayMs: 2000,
  fallbackModels: null,
  // «Разрешать всегда» (permissions.js): [{ tool }, { tool: 'run_command', program }]
  alwaysAllow: [],
  // Профили провайдеров (profiles.js): [{ id, name, provider, baseUrl, model, apiKey }];
  // activeProfile — id или null (тогда обычные поля provider/baseUrl/model/apiKey выше).
  profiles: [],
  activeProfile: null,
};

function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function loadConfig() {
  ensureHome();
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    saved = {};
  }
  return { ...DEFAULTS, ...saved, mcpServers: { ...DEFAULTS.mcpServers, ...(saved.mcpServers || {}) } };
}

function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  ensureHome();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

module.exports = { HOME, CONFIG_FILE, SESSIONS_DIR, DEFAULTS, loadConfig, saveConfig, ensureHome };
