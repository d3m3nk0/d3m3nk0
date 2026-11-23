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

function updateToolCard(id, ok, output) {
  const c = toolCards.get(id);
  if (!c) return;
  c.status.textContent = ok ? 'готово' : 'ошибка';
  c.status.classList.add(ok ? 'ok' : 'err');
  c.out.textContent = output || '(пусто)';
  c.details.open = !ok;
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
        if (res) updateToolCard(b.id, !res.is_error, res.content);
      }
    }
  }
  scrollDown();
}

/* ------------------------------ настройки -------------------------------- */

let currentConfig = null;

async function refreshConfig() {
  const cfg = await window.d3.getConfig();
  currentConfig = cfg;
  $('model-badge').textContent = `${cfg.provider} · ${cfg.model}`;
  $('workdir-badge').textContent = cfg.workdir;
  $('workdir-badge').title = cfg.workdir;
  const servers = Object.keys(cfg.mcpServers || {}).length;
  $('mcp-badge').textContent = `MCP: ${servers}`;

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
      updateToolCard(ev.id, ev.ok, ev.output);
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
    await refreshConfig();
    $('settings').showModal();
    $('s-model').focus();
    return;
  }
  if (res.model) {
    await refreshConfig();
    addInfo(`Модель: ${res.model}`);
  }
};

$('open-settings').onclick = async () => {
  await refreshConfig();
  $('settings').showModal();
};

$('save-settings').onclick = async (e) => {
  e.preventDefault();
  let mcpServers = {};
  try {
    mcpServers = JSON.parse($('s-mcp').value || '{}');
  } catch (err) {
    alert('MCP-серверы: некорректный JSON\n' + err.message);
    return;
  }
  const patch = {
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
  await refreshSessions();
  showEmptyState();
  input.focus();
})();
