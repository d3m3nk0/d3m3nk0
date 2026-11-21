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

  static list() {
    ensureHome();
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
        return { id: f.replace(/\.jsonl$/, ''), mtime: st.mtimeMs, title };
      })
      .sort((a, b) => b.mtime - a.mtime);
  }
}

module.exports = { Session };
