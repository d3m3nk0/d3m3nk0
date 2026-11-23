'use strict';

/**
 * Сессии: append-only журнал в ~/.d3m3nk0/sessions/<id>.jsonl.
 *
 * Формат строки: {"ts": 1234, "entry": {...}}
 * Внутри entry — канонические сообщения агента, чтобы историю можно было
 * восстановить и продолжить разговор.
 *
 * Имя сессии: entry { kind: 'meta', meta: { name } } — пишется ОДИН раз, по
 * первому сообщению пользователя (session-name.js, без модели). Действует первая
 * такая запись; последующие сообщения имя не меняют. Старый код запись meta
 * просто пропускает: load() берёт только kind: 'message'.
 */

const fs = require('node:fs');
const path = require('node:path');
const { SESSIONS_DIR, ensureHome } = require('./config');
const { sessionName } = require('./session-name');

/** Сообщение пользователя с текстом (а не результаты инструментов). */
function isUserText(entry) {
  return entry?.kind === 'message' && entry.message?.role === 'user' && (entry.message.blocks || []).some((b) => b.type === 'text');
}

function textOf(message) {
  return (message.blocks || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(' ');
}

/** Из журнала: сохранённое имя (первая запись meta) и текст первого сообщения пользователя. */
function scanJournal(file) {
  const out = { name: null, firstText: null };
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line).entry;
    } catch {
      continue; // битая строка не должна ломать чтение
    }
    if (entry?.kind === 'meta' && out.name == null && typeof entry.meta?.name === 'string') out.name = entry.meta.name;
    else if (out.firstText == null && isUserText(entry)) out.firstText = textOf(entry.message);
    if (out.name != null && out.firstText != null) break;
  }
  return out;
}

// Закреплённые сессии: массив id в sessions/pinned.json (не .jsonl — в список не попадает).
const PINNED_FILE = path.join(SESSIONS_DIR, 'pinned.json');
// id сессии идёт в путь файла: только буквы, цифры, «-» и «_», чтобы не выйти из папки.
const ID_RE = /^[A-Za-z0-9_-]+$/;

function checkId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(`Недопустимый id сессии: ${id}`);
  return id;
}

function readPinned() {
  try {
    const arr = JSON.parse(fs.readFileSync(PINNED_FILE, 'utf8'));
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function writePinned(set) {
  ensureHome();
  fs.writeFileSync(PINNED_FILE, JSON.stringify([...set], null, 2), 'utf8');
}

function newId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}

class Session {
  constructor(id) {
    ensureHome();
    this.id = id || newId();
    this.file = path.join(SESSIONS_DIR, `${this.id}.jsonl`);
    this.meta = { name: null };
    this.named = false; // имя уже определено (или его не из чего сделать) — больше не трогаем
  }

  append(entry) {
    fs.appendFileSync(this.file, JSON.stringify({ ts: Date.now(), entry }) + '\n', 'utf8');
    if (!this.named && isUserText(entry)) this.ensureName();
  }

  /**
   * Имя по ПЕРВОМУ сообщению пользователя. Сессия могла быть открыта заново
   * (new Session(id) для старого журнала) — поэтому смотрим журнал, а не
   * только текущее сообщение: если имя уже есть, оно не меняется; если журнал
   * старый и без имени, имя берётся из самого первого сообщения в нём.
   */
  ensureName() {
    this.named = true;
    const { name, firstText } = scanJournal(this.file);
    if (name != null) {
      this.meta = { name };
      return;
    }
    const fresh = sessionName(firstText);
    if (!fresh) return; // одни символы — имени нет, в списке будет начало сообщения
    this.meta = { name: fresh };
    fs.appendFileSync(this.file, JSON.stringify({ ts: Date.now(), entry: { kind: 'meta', meta: this.meta } }) + '\n', 'utf8');
  }

  static exists(id) {
    return fs.existsSync(path.join(SESSIONS_DIR, `${id}.jsonl`));
  }

  static load(id) {
    const file = path.join(SESSIONS_DIR, `${id}.jsonl`);
    const entries = [];
    if (!fs.existsSync(file)) return { id, messages: [], entries };
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        entries.push(rec);
      } catch {
        // битая строка не должна ломать загрузку всей сессии
      }
    }
    const messages = entries.filter((e) => e.entry && e.entry.kind === 'message').map((e) => e.entry.message);
    const metaEntry = entries.find((e) => e.entry?.kind === 'meta' && typeof e.entry.meta?.name === 'string');
    return { id, messages, entries, meta: { name: metaEntry ? metaEntry.entry.meta.name : null } };
  }

  /** Путь к журналу сессии; id проверяется, чтобы не выйти из папки сессий. */
  static fileOf(id) {
    return path.join(SESSIONS_DIR, `${checkId(id)}.jsonl`);
  }

  /** Закрепить или открепить сессию. Закреплённые идут первыми в list(). */
  static setPinned(id, pinned) {
    checkId(id);
    const set = readPinned();
    if (pinned) set.add(id);
    else set.delete(id);
    writePinned(set);
  }

  /**
   * Удалить сессию. trash(file) — функция «в Корзину» (в окне это
   * shell.trashItem); без неё файл удаляется насовсем.
   */
  static async remove(id, { trash } = {}) {
    const file = Session.fileOf(id);
    if (fs.existsSync(file)) {
      if (trash) await trash(file);
      else fs.unlinkSync(file);
    }
    const set = readPinned();
    if (set.delete(id)) writePinned(set);
  }

  static list() {
    ensureHome();
    const pinned = readPinned();
    return fs
      .readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const file = path.join(SESSIONS_DIR, f);
        const st = fs.statSync(file);
        const { name, firstText } = scanJournal(file);
        const title = (firstText || '').slice(0, 60);
        const id = f.replace(/\.jsonl$/, '');
        // Старые журналы без записи meta: имя считается на лету, в журнал не пишется.
        return { id, mtime: st.mtimeMs, name: name ?? sessionName(firstText), title, pinned: pinned.has(id) };
      })
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.mtime - a.mtime);
  }
}

module.exports = { Session };
