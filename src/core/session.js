'use strict';

/**
 * Сессии: append-only журнал в ~/.d3m3nk0/sessions/<id>.jsonl.
 *
 * Формат строки: {"ts": 1234, "entry": {...}}
 * Внутри entry — канонические сообщения агента, чтобы историю можно было
 * восстановить и продолжить разговор.
 */

const fs = require('node:fs');
const path = require('node:path');
const { SESSIONS_DIR, ensureHome } = require('./config');

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
  }

  append(entry) {
    fs.appendFileSync(this.file, JSON.stringify({ ts: Date.now(), entry }) + '\n', 'utf8');
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
    return { id, messages, entries };
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
        let title = '';
        try {
          const first = fs.readFileSync(file, 'utf8').split('\n').find((l) => l.includes('"role":"user"'));
          if (first) {
            const msg = JSON.parse(first).entry.message;
            const text = (msg.blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
            title = text.slice(0, 60);
          }
        } catch {
          // заголовок необязателен
        }
        const id = f.replace(/\.jsonl$/, '');
        return { id, mtime: st.mtimeMs, title, pinned: pinned.has(id) };
      })
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.mtime - a.mtime);
  }
}

module.exports = { Session };
