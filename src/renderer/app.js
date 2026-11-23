'use strict';

/* UI-слой. Никакой логики агента здесь нет: только отрисовка событий. */

const $ = (id) => document.getElementById(id);
const transcript = $('transcript');
const permissionArea = $('permission-area');
const input = $('input');
const sendBtn = $('send');
const stopBtn = $('stop');
const hint = $('hint');

let currentAssistant = null;
const toolCards = new Map();
let busy = false;

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

const scrollDown = () => {
  transcript.scrollTop = transcript.scrollHeight;
};

function addUser(text) {
  transcript.querySelector('.empty')?.remove();
  transcript.append(el('div', 'msg user', text));
  scrollDown();
}

function addInfo(text) {
  transcript.append(el('div', 'msg info', text));
  scrollDown();
}

function addError(text) {
  transcript.append(el('div', 'msg error', text));
  scrollDown();
}

/* ------------------------- ответы модели в Markdown ------------------------ */

const mdHooks = { openLink: (url) => window.d3.openExternal(url) };
const rawText = new WeakMap(); // пузырь ответа -> его исходный текст
const pendingRender = new Set();
let renderQueued = false;

/** Перерисовать пузырь из rawText. Во время стриминга — не чаще раза за кадр. */
function renderAssistant(node, now = false) {
  if (now) {
    pendingRender.delete(node);
    window.Markdown.renderMarkdownInto(node, rawText.get(node) || '', mdHooks);
    return;
  }
  pendingRender.add(node);
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    for (const n of pendingRender) window.Markdown.renderMarkdownInto(n, rawText.get(n) || '', mdHooks);
    pendingRender.clear();
    scrollDown();
  });
}

function addAssistant(text) {
  const node = el('div', 'msg assistant md');
  rawText.set(node, text);
  renderAssistant(node, true);
  transcript.append(node);
  return node;
}

function ensureAssistant() {
  if (!currentAssistant) {
    currentAssistant = addAssistant('');
  }
  return currentAssistant;
}

function endAssistant() {
  currentAssistant = null;
}

/* ----------------------- рассуждение и вызовы инструментов --------------------- */

let currentReasoning = null; // тело открытого блока «Рассуждение» текущего шага
const pendingTools = new Map(); // id вызова -> строка «Вызываю инструмент…»

/** Блок «Рассуждение» шага: свёрнут по умолчанию, текст дописывается по мере прихода. */
function ensureReasoning() {
  if (!currentReasoning) {
    const box = el('details', 'reasoning');
    box.append(el('summary', null, 'Рассуждение'));
    currentReasoning = el('div', 'reasoning-body', '');
    box.append(currentReasoning);
    transcript.append(box);
  }
  return currentReasoning;
}

function endReasoning() {
  currentReasoning = null;
}

function addPendingTool(id, name) {
  const line = el('div', 'msg pending-tool', `▸ Вызываю инструмент: ${name}…`);
  line.dataset.name = name;
  pendingTools.set(id, line);
  transcript.append(line);
  scrollDown();
}

/** Убрать строку ожидания: по id, а если провайдер сменил id — по имени. */
function removePendingTool(id, name) {
  let key = pendingTools.has(id) ? id : null;
  if (!key) for (const [k, line] of pendingTools) if (line.dataset.name === name) { key = k; break; }
  if (key == null) return;
  pendingTools.get(key).remove();
  pendingTools.delete(key);
}

function clearPendingTools() {
  for (const line of pendingTools.values()) line.remove();
  pendingTools.clear();
}

/* ---------------------------- строка состояния ---------------------------- */

// Что сейчас делает агент. Фаза меняется по последнему событию, таймер тикает
// раз в секунду, чтобы тишина не выглядела как зависание.
let phase = null; // { text, since }
let phaseTimer = null;

function renderPhase() {
  if (!phase) {
    hint.textContent = '';
    return;
  }
  const sec = Math.floor((Date.now() - phase.since) / 1000);
  hint.textContent = sec >= 1 ? `${phase.text} ${sec} с` : phase.text;
}

function setPhase(text) {
  if (!text) {
    phase = null;
    clearInterval(phaseTimer);
    phaseTimer = null;
  } else {
    if (phase?.text !== text) phase = { text, since: Date.now() };
    if (!phaseTimer) phaseTimer = setInterval(renderPhase, 1000);
  }
  renderPhase();
}

function addToolCard(id, name, input) {
  const card = el('div', 'tool');
  card.dataset.id = id;

  const head = el('div', 'tool-head');
  head.append(el('span', 'tool-name', name));
  const status = el('span', 'tool-status', 'выполняется…');
  head.append(status);
  card.append(head);

  if (input && Object.keys(input).length) {
    const pre = el('pre', 'tool-input', JSON.stringify(input, null, 2));
    card.append(pre);
  }

  const details = el('details');
  details.append(el('summary', null, 'вывод'));
  const out = el('pre', 'tool-output', '');
  details.append(out);
  card.append(details);

  transcript.append(card);
  toolCards.set(id, { card, status, out, details });
  scrollDown();
}

function updateToolCard(id, ok, output, image) {
  const c = toolCards.get(id);
  if (!c) return;
  c.status.textContent = ok ? 'готово' : 'ошибка';
  c.status.classList.add(ok ? 'ok' : 'err');
  c.out.textContent = output || '(пусто)';
  c.details.open = !ok;
  // view_image: показать, что именно увидела модель. В старых сессиях
  // данных картинки нет (в журнал она не пишется) — только подпись.
  if (image) {
    if (image.data && /^image\/(png|jpeg|gif|webp)$/.test(image.media_type)) {
      const img = el('img', 'tool-image');
      img.alt = image.path || 'картинка';
      img.src = `data:${image.media_type};base64,${image.data}`;
      img.onclick = () => img.classList.toggle('big');
      img.title = 'Клик — крупнее';
      c.card.insertBefore(img, c.details);
    } else {
      c.card.insertBefore(el('div', 'tool-image-note', `🖼 ${image.path || 'картинка'} (в истории не хранится)`), c.details);
    }
  }
  scrollDown();
}

function showPermission(req) {
  const box = el('div', 'perm');
  box.append(el('div', 'perm-title', `Запрос доступа: ${req.name}`));
  box.append(el('pre', null, JSON.stringify(req.input, null, 2)));

  const actions = el('div', 'perm-actions');
  const deny = el('button', 'ghost', 'Отклонить');
  const allow = el('button', null, 'Разрешить');
  actions.append(deny, allow);
  box.append(actions);

  deny.onclick = () => {
    window.d3.replyPermission(req.id, false);
    box.remove();
  };
  allow.onclick = () => {
    window.d3.replyPermission(req.id, true);
    box.remove();
  };

  permissionArea.append(box);
  scrollDown();
}

/** Пустое состояние: без него первый экран — просто пустая область. */
function showEmptyState() {
  if (transcript.querySelector('.empty')) return;
  // init() асинхронный: если пользователь успел отправить сообщение раньше,
  // заметка «Готов к работе» дорисовалась бы под ним.
  if (transcript.querySelector('.msg.user, .msg.assistant')) return;
  const box = el('div', 'empty');
  box.append(el('h3', null, 'Готов к работе'));
  const list = el('ul');
  const modeText = {
    ask: 'Правки файлов и команды спрашивают подтверждение (режим ask).',
    'allow-edits': 'Правки файлов без спроса, команды и MCP — с подтверждением (режим allow-edits).',
    yolo: 'Агент ничего не спрашивает (режим yolo). Осторожно.',
  };
  for (const line of [
    'Опишите задачу — агент сам прочитает нужные файлы и покажет, что делает.',
    modeText[currentConfig?.permissionMode] || modeText.ask,
    'MCP-серверы подключаются в настройках и приносят свои инструменты.',
    'Модель меняется кликом по её названию вверху.',
  ]) {
    list.append(el('li', null, line));
  }
  box.append(list);
  transcript.append(box);
}

function renderHistory(messages) {
  transcript.replaceChildren();
  toolCards.clear();
  pendingTools.clear();
  endReasoning();
  if (!messages.length) {
    showEmptyState();
    return;
  }
  const resultsById = new Map();
  for (const m of messages) {
    for (const b of m.blocks || []) if (b.type === 'tool_result') resultsById.set(b.id, b);
  }
  for (const m of messages) {
    for (const b of m.blocks || []) {
      if (b.type === 'text' && b.text.trim()) {
        if (m.role === 'user') addUser(b.text);
        else addAssistant(b.text);
      } else if (b.type === 'tool_use') {
        addToolCard(b.id, b.name, b.input);
        const res = resultsById.get(b.id);
        if (res) updateToolCard(b.id, !res.is_error, res.content, res.image);
      }
    }
  }
  scrollDown();
}

/* ------------------------------ настройки -------------------------------- */

let currentConfig = null;
let mcpToolsKnown = false;

async function refreshConfig() {
  const cfg = await window.d3.getConfig();
  currentConfig = cfg;
  $('model-badge').textContent = `${cfg.provider} · ${cfg.model}`;
  $('workdir-badge').textContent = cfg.workdir;
  $('workdir-badge').title = cfg.workdir;
  // Пока MCP не прислал статус, показываем число серверов; потом — число
  // инструментов, и повторное открытие настроек его не затирает.
  if (!mcpToolsKnown) $('mcp-badge').textContent = `MCP: ${Object.keys(cfg.mcpServers || {}).length}`;

  $('s-name').value = cfg.displayName || '';
  $('s-provider').value = cfg.provider;
  $('s-model').value = cfg.model;
  $('s-baseurl').value = cfg.baseUrl;
  $('s-apikey').value = cfg.apiKey || '';
  $('s-workdir').value = cfg.workdir;
  $('s-permission').value = cfg.permissionMode;
  $('s-mcp').value = JSON.stringify(cfg.mcpServers || {}, null, 2);
}

async function refreshSessions() {
  const list = await window.d3.listSessions();
  const box = $('sessions');
  box.replaceChildren();
  for (const s of list) {
    const btn = el('button', 'session', s.title || s.id);
    btn.title = `${s.id}\nПравый клик — закрепить или удалить`;
    if (s.pinned) btn.classList.add('pinned');
    if (s.current) btn.classList.add('active');
    btn.onclick = async () => {
      const res = await window.d3.loadSession(s.id);
      renderHistory(res.messages);
      for (const b of box.children) b.classList.remove('active');
      btn.classList.add('active');
      addInfo(`Сессия ${s.id} загружена`);
    };
    btn.oncontextmenu = async (e) => {
      e.preventDefault();
      const res = await window.d3.sessionMenu(s.id, s.pinned);
      if (res.error) addError(res.error);
      if (!res.action) return;
      if (res.action === 'delete') {
        if (res.wasCurrent) {
          renderHistory([]);
          addInfo(`Сессия удалена, начата новая ${res.newId}`);
        } else {
          addInfo('Сессия перемещена в Корзину');
        }
      }
      refreshSessions();
    };
    box.append(btn);
  }
}

/* --------------------------------- события ------------------------------- */

window.d3.onEvent((ev) => {
  switch (ev.type) {
    case 'assistant_text': {
      const node = ensureAssistant();
      rawText.set(node, (rawText.get(node) || '') + ev.text);
      renderAssistant(node);
      setPhase(null); // текст виден сам, индикатор не нужен
      break;
    }
    case 'assistant_reasoning': {
      const body = ensureReasoning();
      body.textContent += ev.text;
      setPhase('модель думает…');
      scrollDown();
      break;
    }
    case 'stream_open':
      setPhase('модель думает…');
      break;
    case 'tool_call_start':
      endAssistant(); // текст после вызова пойдёт новым пузырём
      endReasoning();
      addPendingTool(ev.id, ev.name);
      setPhase(`▸ Вызываю инструмент: ${ev.name}…`);
      break;
    case 'assistant_message': {
      const text = (ev.message.blocks || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (text) {
        const node = ensureAssistant();
        rawText.set(node, text);
        renderAssistant(node, true);
        scrollDown();
      }
      endAssistant();
      break;
    }
    case 'tool_start':
      removePendingTool(ev.id, ev.name); // строку ожидания сменяет обычная карточка
      addToolCard(ev.id, ev.name, ev.input);
      setPhase(`выполняется ${ev.name}…`);
      break;
    case 'tool_end':
      removePendingTool(ev.id, ev.name); // вызов отклонён — карточки не было
      updateToolCard(ev.id, ev.ok, ev.output, ev.image);
      break;
    case 'turn_start':
      endReasoning(); // у каждого шага свой блок рассуждения
      setPhase('ждём ответ сервера…');
      break;
    case 'info':
      addInfo(ev.message);
      break;
    case 'error':
      addError(ev.message);
      break;
    case 'mcp_status':
      mcpToolsKnown = true;
      $('mcp-badge').textContent = `MCP: ${ev.servers.reduce((n, s) => n + s.tools, 0)} инстр.`;
      break;
    case 'idle':
      endAssistant(); // после «Стоп» следующий ответ не должен приклеиться к прерванному
      endReasoning();
      clearPendingTools();
      setPhase(null);
      setBusy(false);
      refreshSessions();
      break;
  }
});

window.d3.onPermission((req) => showPermission(req));

/* -------------------------------- действия ------------------------------- */

function setBusy(value) {
  busy = value;
  sendBtn.disabled = value;
  stopBtn.hidden = !value;
  input.disabled = value;
  if (!value) input.focus();
}

async function send() {
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = '';
  addUser(text);
  setBusy(true);
  setPhase('ждём ответ сервера…');
  try {
    await window.d3.send(text);
  } catch (e) {
    addError(String(e.message || e));
    setBusy(false);
  }
}

sendBtn.onclick = send;
stopBtn.onclick = () => window.d3.abort();

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

$('new-session').onclick = async () => {
  const res = await window.d3.newSession();
  renderHistory([]);
  addInfo(`Новая сессия ${res.id}`);
  refreshSessions();
};

// Клик по названию модели: меню быстрых моделей без захода в настройки.
$('model-badge').onclick = async () => {
  const res = await window.d3.modelMenu();
  if (res.error) addError(res.error);
  if (res.openSettings) {
    await openSettings('model');
    $('s-model').focus();
    return;
  }
  if (res.model) {
    await refreshConfig();
    addInfo(`Модель: ${res.model}`);
  }
};

/* ----------------------- настройки: разделы слева ------------------------ */

const settingsDlg = $('settings');

function selectTab(tab) {
  for (const b of settingsDlg.querySelectorAll('.sv2-nav [data-tab]')) {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-current', on ? 'page' : 'false');
  }
  for (const s of settingsDlg.querySelectorAll('[data-pane]')) s.hidden = s.dataset.pane !== tab;
}

for (const b of settingsDlg.querySelectorAll('.sv2-nav [data-tab]')) {
  b.onclick = () => selectTab(b.dataset.tab);
}

async function openSettings(tab = 'profile') {
  await refreshConfig();
  mcpDraft = structuredClone(currentConfig?.mcpServers || {});
  syncMcpJson();
  $('plugin-filter').value = '';
  $('pa-error').hidden = true;
  $('mcp-json-error').hidden = true;
  renderLook();
  selectTab(tab);
  settingsDlg.showModal();
  settingsDlg.querySelector('.sv2-nav .active')?.focus(); // а не крестик «Закрыть»
  await renderPlugins();
}

/* ------------------------------ плагины (MCP) ----------------------------- */

// Черновик плагинов: правится переключателями и формой, в конфиг уходит по «Сохранить».
let mcpDraft = {};
const PLUGIN_NAME = /^[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/; // без «__»: это разделитель в mcp__<плагин>__<инструмент>

function syncMcpJson() {
  $('s-mcp').value = JSON.stringify(mcpDraft, null, 2);
}

async function renderPlugins() {
  const list = $('plugin-list');
  const saved = currentConfig?.mcpServers || {};
  const status = new Map((await window.d3.plugins()).map((p) => [p.name, p]));
  const q = $('plugin-filter').value.trim().toLowerCase();
  list.replaceChildren();

  const names = Object.keys(mcpDraft).filter((n) => n.toLowerCase().includes(q));
  if (!names.length) {
    list.append(el('div', 'pane-note', Object.keys(mcpDraft).length ? 'Ничего не найдено.' : 'Плагинов пока нет. Добавьте первый ниже.'));
    return;
  }

  for (const name of names) {
    const cfg = mcpDraft[name] || {};
    const enabled = !cfg.disabled;
    const st = status.get(name);
    const changed = !saved[name] || !!saved[name].disabled !== !!cfg.disabled;

    const card = el('div', 'plugin');
    const icon = el('div', 'plugin-icon', name[0].toUpperCase());
    const text = el('div', 'plugin-text');
    text.append(el('div', 'plugin-name', name));

    let line;
    if (changed) line = enabled ? 'включится после сохранения' : 'выключится после сохранения';
    else if (!enabled) line = 'выключен';
    else if (st?.state === 'ok') line = `подключён · ${st.tools} из ${st.total} инструментов`;
    else if (st?.state === 'error') line = `ошибка: ${st.error}`;
    else line = 'подключается…';
    const sub = el('div', 'plugin-sub', line);
    if (!changed && st?.state === 'error' && enabled) sub.classList.add('err');
    if (!changed && st?.state === 'ok' && enabled) sub.classList.add('ok');
    const cmd = (cfg.command || '').split(/[\\/]/).pop();
    if (cmd) sub.title = `${cfg.command} ${(cfg.args || []).join(' ')}`;
    text.append(sub);

    const sw = el('input');
    sw.type = 'checkbox';
    sw.className = 'switch';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-label', `Плагин ${name}`);
    sw.checked = enabled;
    sw.onchange = () => {
      if (sw.checked) delete mcpDraft[name].disabled;
      else mcpDraft[name].disabled = true;
      syncMcpJson();
      renderPlugins();
    };

    const del = el('button', 'ghost icon-btn', '✕');
    del.type = 'button';
    del.title = 'Удалить плагин';
    del.setAttribute('aria-label', `Удалить плагин ${name}`);
    del.onclick = () => {
      if (!confirm(`Удалить плагин «${name}» из настроек? Сама программа на диске останется.`)) return;
      delete mcpDraft[name];
      syncMcpJson();
      renderPlugins();
    };

    card.append(icon, text, sw, del);
    list.append(card);
  }
}

$('plugin-filter').oninput = () => renderPlugins();

$('pa-add').onclick = () => {
  const name = $('pa-name').value.trim();
  const command = $('pa-command').value.trim();
  const args = $('pa-args').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const err = $('pa-error');
  let msg = '';
  if (!PLUGIN_NAME.test(name)) msg = 'Имя: только латиница, цифры, «-» и «_» (без двойного «__»).';
  else if (mcpDraft[name]) msg = `Плагин «${name}» уже есть.`;
  else if (!command) msg = 'Укажите команду запуска.';
  err.textContent = msg;
  err.hidden = !msg;
  if (msg) return;
  mcpDraft[name] = { command, args };
  $('pa-name').value = '';
  $('pa-command').value = '';
  $('pa-args').value = '';
  syncMcpJson();
  renderPlugins();
};
for (const id of ['pa-name', 'pa-command', 'pa-args']) $(id).addEventListener('input', () => ($('pa-error').hidden = true));

// Правка JSON вручную: если он верный — список обновляется из него.
$('s-mcp').addEventListener('change', () => {
  const err = $('mcp-json-error');
  try {
    const parsed = JSON.parse($('s-mcp').value || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('нужен объект { "имя": {...} }');
    mcpDraft = parsed;
    err.hidden = true;
    renderPlugins();
  } catch (e) {
    err.textContent = `JSON с ошибкой: ${e.message}`;
    err.hidden = false;
  }
});

/* ------------------------------ внешний вид ------------------------------- */

// Всё хранение и применение — в look.js (window.Look); здесь только меню.
const PREVIEW = [
  "Пример ответа: **жирный**, *курсив*, `код в строке`.",
  "",
  "```python",
  "def area(d):",
  "    # площадь круга, мм²",
  "    return 3.1416 * d ** 2 / 4  # S = πd²/4",
  "",
  "print(area(50), \"мм²\")",
  "```",
].join('\n');

function fillSelect(id, key, look) {
  const sel = $(id);
  if (!sel.options.length) {
    for (const o of window.Look.OPTIONS[key]) sel.append(new Option(o.label, o.value));
    sel.onchange = () => renderLook(window.Look.set(key, sel.value));
  }
  sel.value = look[key];
}

function renderLook(look = window.Look.load()) {
  const theme = $('look-theme');
  theme.replaceChildren();
  const icons = { system: '🖥', light: '☀', dark: '☾' };
  for (const o of window.Look.OPTIONS.theme) {
    const b = el('button', 'seg-btn', `${icons[o.value]}  ${o.label}`);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(look.theme === o.value));
    if (look.theme === o.value) b.classList.add('on');
    b.onclick = () => renderLook(window.Look.set('theme', o.value));
    theme.append(b);
  }
  const sw = $('look-accent');
  sw.replaceChildren();
  const dark = window.Look.effectiveTheme(look) === 'dark';
  for (const o of window.Look.OPTIONS.accent) {
    const b = el('button', 'swatch');
    b.type = 'button';
    b.style.background = dark ? o.dark : o.light;
    b.title = o.label;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', o.label);
    b.setAttribute('aria-checked', String(look.accent === o.value));
    if (look.accent === o.value) b.classList.add('on');
    b.onclick = () => renderLook(window.Look.set('accent', o.value));
    sw.append(b);
  }
  for (const k of ['fontUi', 'fontAnswer', 'fontSize', 'col', 'fontCode', 'code']) fillSelect(`look-${k}`, k, look);
  window.Markdown.renderMarkdownInto($('look-preview'), PREVIEW);
}

$('look-reset').onclick = () => renderLook(window.Look.reset());

/* ------------------------------ меню профиля ------------------------------ */

const profileBtn = $('profile');
const profileMenu = $('profile-menu');

async function refreshProfile() {
  const info = await window.d3.appInfo();
  $('pf-name').textContent = info.name;
  $('pf-avatar').textContent = (info.name.trim()[0] || '?').toUpperCase();
  $('pf-sub').textContent = info.hasKey ? info.provider : `${info.provider} · нет ключа`;
  $('pf-sub').classList.toggle('warn', !info.hasKey);
  $('pm-head').textContent = info.hasKey ? `Модель через ${info.provider} по API-ключу` : 'API-ключ не задан';
  return info;
}

function setProfileMenu(open) {
  profileMenu.hidden = !open;
  profileBtn.setAttribute('aria-expanded', String(open));
  if (open) profileMenu.querySelector('.pop-item')?.focus();
}

profileBtn.onclick = (e) => {
  e.stopPropagation();
  setProfileMenu(profileMenu.hidden);
};
document.addEventListener('click', (e) => {
  if (!profileMenu.hidden && !profileMenu.contains(e.target)) setProfileMenu(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !profileMenu.hidden) {
    setProfileMenu(false);
    profileBtn.focus();
  }
  if (e.ctrlKey && e.key === ',') {
    e.preventDefault();
    setProfileMenu(false);
    openSettings();
  }
});

/** Показать окно с заголовком и строками «название — значение». */
function showInfo(title, rows, note) {
  $('info-title').textContent = title;
  const body = $('info-body');
  body.replaceChildren();
  const table = el('table', 'kv');
  for (const [k, v] of rows) {
    const tr = el('tr');
    tr.append(el('td', null, k));
    const td = el('td');
    if (v instanceof Node) td.append(v);
    else td.textContent = v;
    tr.append(td);
    table.append(tr);
  }
  body.append(table);
  if (note) body.append(el('p', 'info-note', note));
  $('info-dialog').showModal();
}

const fmt = (n) => Number(n || 0).toLocaleString('ru-RU');

profileMenu.addEventListener('click', async (e) => {
  const item = e.target.closest('.pop-item');
  if (!item) return;
  setProfileMenu(false);
  const act = item.dataset.act;
  if (act === 'settings') openSettings();
  else if (act === 'plugins') openSettings('plugins');
  else if (act === 'usage') {
    const u = await window.d3.usage();
    const share = u.budget ? Math.min(100, Math.round((u.contextTokens / u.budget) * 100)) : 0;
    const bar = el('div', 'meter');
    const fill = el('div', 'meter-fill');
    fill.style.width = `${share}%`;
    bar.append(fill);
    const ctx = el('div');
    ctx.append(el('div', null, `~${fmt(u.contextTokens)} из ${fmt(u.budget)} токенов (${share}%)`), bar);
    showInfo(
      'Использование',
      [
        ['Модель', u.model],
        ['Подключение', u.provider],
        ['Сессия', u.sessionId],
        ['Сообщений в истории', fmt(u.messages)],
        ['Контекст следующего запроса', ctx],
      ],
      'Это оценка размера текущего разговора. Сколько запросов осталось на бесплатном ключе, смотрите в кабинете провайдера (для NVIDIA — build.nvidia.com).',
    );
  } else if (act === 'workdir' || act === 'help') {
    const res = await window.d3.openPlace(act);
    if (!res.ok) addError(`Не удалось открыть: ${res.error || act}`);
  } else if (act === 'about') {
    const info = await window.d3.appInfo();
    showInfo('О программе', [
      ['d3m3nk0', info.version],
      ['Electron', info.electron],
      ['Node.js', info.node],
      ['Подключение', info.hasKey ? `${info.provider}, ключ задан` : `${info.provider}, ключа нет`],
    ], 'Десктопный агент для работы с кодом. Аккаунта нет: модель подключена по API-ключу из настроек.');
  }
});

$('save-settings').onclick = async (e) => {
  e.preventDefault();
  let mcpServers = {};
  try {
    mcpServers = JSON.parse($('s-mcp').value || '{}');
  } catch (err) {
    selectTab('plugins');
    $('s-mcp').closest('details').open = true;
    $('mcp-json-error').textContent = `JSON с ошибкой: ${err.message}`;
    $('mcp-json-error').hidden = false;
    return;
  }
  const patch = {
    displayName: $('s-name').value.trim(),
    provider: $('s-provider').value,
    model: $('s-model').value.trim(),
    baseUrl: $('s-baseurl').value.trim(),
    apiKey: $('s-apikey').value,
    workdir: $('s-workdir').value.trim(),
    permissionMode: $('s-permission').value,
    mcpServers,
  };
  await window.d3.setConfig(patch);
  $('settings').close();
  await refreshConfig();
  await refreshProfile();
  addInfo('Настройки сохранены');
};

/* ------------------------- ширина боковой панели ------------------------- */

// Полосу между списком сессий и чатом можно тянуть мышью или стрелками
// (когда она в фокусе). Ширина запоминается, двойной клик возвращает исходную.
const SIDEBAR = { def: 240, min: 170, maxShare: 0.45, key: 'd3m3nk0.sidebarWidth' };
const resizer = $('sidebar-resizer');

function clampSidebar(px) {
  const max = Math.max(SIDEBAR.min, Math.floor(window.innerWidth * SIDEBAR.maxShare));
  return Math.round(Math.min(Math.max(px, SIDEBAR.min), max));
}

function setSidebarWidth(px, save = true) {
  const w = clampSidebar(px);
  document.body.style.setProperty('--sidebar-w', `${w}px`);
  resizer.setAttribute('aria-valuenow', String(w));
  if (save) localStorage.setItem(SIDEBAR.key, String(w));
  return w;
}

function sidebarWidth() {
  return $('sidebar').getBoundingClientRect().width;
}

resizer.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  const startX = e.clientX;
  const startW = sidebarWidth();
  document.body.classList.add('resizing');
  // Слушаем весь документ, а не полосу в 8 px: при быстром рывке мышь
  // уходит с полосы, и события до неё уже не доходят.
  const move = (ev) => setSidebarWidth(startW + ev.clientX - startX, false);
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    window.removeEventListener('blur', up);
    document.body.classList.remove('resizing');
    setSidebarWidth(sidebarWidth()); // сохранить итог один раз, а не на каждый пиксель
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  window.addEventListener('blur', up); // отпустили кнопку за пределами окна
});

resizer.addEventListener('dblclick', () => setSidebarWidth(SIDEBAR.def));

resizer.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 40 : 10;
  if (e.key === 'ArrowLeft') setSidebarWidth(sidebarWidth() - step);
  else if (e.key === 'ArrowRight') setSidebarWidth(sidebarWidth() + step);
  else if (e.key === 'Home' || e.key === 'Enter') setSidebarWidth(SIDEBAR.def);
  else return;
  e.preventDefault();
});

const savedSidebar = () => Number(localStorage.getItem(SIDEBAR.key)) || SIDEBAR.def;

// Окно сузили — панель не больше своей доли; расширили — снова сохранённая ширина.
window.addEventListener('resize', () => setSidebarWidth(savedSidebar(), false));

setSidebarWidth(savedSidebar(), false);

/* --------------------------------- старт --------------------------------- */

(async function init() {
  await refreshConfig();
  await refreshProfile();
  await refreshSessions();
  showEmptyState();
  input.focus();
})();

/* --------------------------- внешние ссылки ---------------------------- */

// Любая http(s)-ссылка в окне открывается в браузере, а не внутри агента.
// Ссылки из ответов модели уже обработаны в markdown.js (defaultPrevented).
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href]');
  if (!a || e.defaultPrevented) return;
  const href = a.getAttribute('href');
  if (!/^https?:\/\//i.test(href)) return;
  e.preventDefault();
  window.d3.openExternal(href);
});
