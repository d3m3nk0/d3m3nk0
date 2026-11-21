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

function ensureAssistant() {
  if (!currentAssistant) {
    currentAssistant = el('div', 'msg assistant', '');
    transcript.append(currentAssistant);
  }
  return currentAssistant;
}

function endAssistant() {
  currentAssistant = null;
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
  const box = el('div', 'empty');
  box.append(el('h3', null, 'Готов к работе'));
  const list = el('ul');
  for (const line of [
    'Опишите задачу — агент сам прочитает нужные файлы и покажет, что делает.',
    'Правки файлов и команды спрашивают подтверждение (режим ask).',
    'MCP-серверы подключаются в настройках и приносят свои инструменты.',
  ]) {
    list.append(el('li', null, line));
  }
  box.append(list);
  transcript.append(box);
}

function renderHistory(messages) {
  transcript.replaceChildren();
  toolCards.clear();
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
        else {
          const node = el('div', 'msg assistant', b.text);
          transcript.append(node);
        }
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

async function refreshConfig() {
  const cfg = await window.d3.getConfig();
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
    btn.title = s.id;
    btn.onclick = async () => {
      const res = await window.d3.loadSession(s.id);
      renderHistory(res.messages);
      for (const b of box.children) b.classList.remove('active');
      btn.classList.add('active');
      addInfo(`Сессия ${s.id} загружена`);
    };
    box.append(btn);
  }
}

/* --------------------------------- события ------------------------------- */

window.d3.onEvent((ev) => {
  switch (ev.type) {
    case 'assistant_text': {
      const node = ensureAssistant();
      node.textContent += ev.text;
      scrollDown();
      break;
    }
    case 'assistant_message': {
      const text = (ev.message.blocks || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (text) {
        const node = ensureAssistant();
        node.textContent = text;
      }
      endAssistant();
      break;
    }
    case 'tool_start':
      addToolCard(ev.id, ev.name, ev.input);
      break;
    case 'tool_end':
      updateToolCard(ev.id, ev.ok, ev.output);
      break;
    case 'turn_start':
      hint.textContent = 'модель думает…';
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
      hint.textContent = '';
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
  hint.textContent = 'модель думает…';
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

/* --------------------------------- старт --------------------------------- */

(async function init() {
  await refreshConfig();
  await refreshSessions();
  showEmptyState();
  input.focus();
})();
