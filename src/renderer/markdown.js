'use strict';

/**
 * Маленький Markdown для ответов модели.
 *
 * Безопасность: текст модели никогда не идёт в innerHTML. Сначала он
 * разбирается в дерево (parseBlocks / parseInline), потом дерево строится
 * через createElement + textContent. Поэтому <script> или <img onerror> из
 * ответа модели показываются как обычный текст.
 *
 * Поддержано: абзацы, заголовки #–######, списки (-, *, +, 1.), цитаты >,
 * линия ---, таблицы |a|b|, блоки ```кода``` (в том числе незакрытые — во
 * время стриминга), а в строке: `код`, **жирный**, *курсив*, _курсив_, ссылки.
 */

const SAFE_URL = /^(https?:|mailto:)/i;

/* ------------------------------ подсветка кода ------------------------------ */

// Простая подсветка без внешних библиотек: строки, комментарии, числа,
// ключевые слова, вызовы функций и $переменные. Возвращает куски текста с
// типом; склеенные обратно, они дают ровно исходный код (это проверяет тест).

const NO_HIGHLIGHT = new Set(['', 'text', 'txt', 'plain', 'plaintext', 'md', 'markdown', 'log', 'output', 'код']);
const HASH_COMMENTS = new Set(['py', 'python', 'sh', 'bash', 'shell', 'zsh', 'ps', 'ps1', 'powershell', 'pwsh', 'yaml', 'yml', 'toml', 'rb', 'ruby', 'r', 'dockerfile', 'ini', 'conf']);
const KEYWORDS = new Set(
  ('const let var function return if else elif for while do break continue class new import from export default ' +
    'try catch finally throw async await def lambda in of is not and or None True False null true false undefined ' +
    'this self print echo param foreach switch case public private protected static void int string bool float ' +
    'double struct enum interface type extends implements yield with as pass raise except global fn mut use pub ' +
    'impl match where select begin end then local require module exports package go func defer range map')
    .split(' '),
);

function highlightCode(code, lang) {
  const text = String(code ?? '');
  const l = String(lang || '').toLowerCase();
  if (NO_HIGHLIGHT.has(l)) return [{ t: null, v: text }];
  const isJson = l === 'json' || l === 'jsonc';
  const hash = HASH_COMMENTS.has(l);
  const out = [];
  const push = (t, v) => {
    if (!v) return;
    const last = out[out.length - 1];
    if (last && last.t === t) last.v += v;
    else out.push({ t, v });
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    let m;
    if ((m = rest.match(/^\/\*[\s\S]*?(\*\/|$)/)) || (m = rest.match(/^<!--[\s\S]*?(-->|$)/))) push('com', m[0]);
    else if ((m = rest.match(/^\/\/[^\n]*/)) && !isJson) push('com', m[0]);
    else if (hash && (m = rest.match(/^#[^\n]*/))) push('com', m[0]);
    else if ((m = rest.match(/^("""|''')[\s\S]*?(\1|$)/))) push('str', m[0]);
    else if ((m = rest.match(/^"(?:[^"\\\n]|\\.)*"?/)) || (m = rest.match(/^'(?:[^'\\\n]|\\.)*'?/)) || (m = rest.match(/^`(?:[^`\\]|\\.)*`?/))) push('str', m[0]);
    else if ((m = rest.match(/^(0x[0-9a-fA-F]+|\d+(?:[.,]\d+)?(?:e[+-]?\d+)?)\b/)) && !/[\w$]$/.test(text.slice(0, i))) push('num', m[0]);
    else if ((m = rest.match(/^\$[A-Za-z_][\w:]*/))) push('fn', m[0]);
    else if ((m = rest.match(/^[A-Za-z_][\w-]*/u))) {
      const word = m[0].includes('-') && !/^[A-Z][a-z]+-[A-Z]/.test(m[0]) ? m[0].match(/^[A-Za-z_]\w*/)[0] : m[0];
      const after = text.slice(i + word.length);
      if (isJson ? /^(true|false|null)$/.test(word) : KEYWORDS.has(word)) push('kw', word);
      else if (/^\s*\(/.test(after) || /^[A-Z][a-z]+-[A-Z]\w*$/.test(word)) push('fn', word); // вызов или Командлет-PowerShell
      else push(null, word);
      i += word.length;
      continue;
    } else push(null, text[i]);
    i += m ? m[0].length : 1;
  }
  return out;
}

/* --------------------------------- разбор строки -------------------------------- */

function parseInline(text) {
  const out = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    let m;
    if ((m = rest.match(/^(`+)([\s\S]*?[^`])\1(?!`)/))) {
      flush();
      out.push({ t: 'code', v: m[2].trim() === '' ? m[2] : m[2].replace(/^ (.*) $/, '$1') });
      i += m[0].length;
    } else if ((m = rest.match(/^\[([^\]\n]+)\]\(([^)\s]+)\)/)) && SAFE_URL.test(m[2])) {
      flush();
      out.push({ t: 'link', text: m[1], href: m[2] });
      i += m[0].length;
    } else if ((m = rest.match(/^(\*\*|__)(?=\S)([\s\S]*?\S)\1/))) {
      flush();
      out.push({ t: 'bold', children: parseInline(m[2]) });
      i += m[0].length;
    } else if ((m = rest.match(/^\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/))) {
      flush();
      out.push({ t: 'italic', children: parseInline(m[1]) });
      i += m[0].length;
    } else if ((m = rest.match(/^_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}])/u)) && !/[\p{L}\p{N}]$/u.test(buf)) {
      flush();
      out.push({ t: 'italic', children: parseInline(m[1]) });
      i += m[0].length;
    } else {
      buf += text[i];
      i += 1;
    }
  }
  flush();
  return out;
}

/* --------------------------------- разбор блоков -------------------------------- */

const RE_FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const RE_HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const RE_UL = /^(\s*)[-*+]\s+(.*)$/;
const RE_OL = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const RE_QUOTE = /^\s{0,3}>\s?(.*)$/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function isBlockStart(line, next) {
  return (
    RE_FENCE.test(line) ||
    RE_HEADING.test(line) ||
    RE_HR.test(line) ||
    RE_UL.test(line) ||
    RE_OL.test(line) ||
    RE_QUOTE.test(line) ||
    (line.includes('|') && next !== undefined && RE_TABLE_SEP.test(next))
  );
}

function parseBlocks(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;

    if (!line.trim()) {
      i += 1;
      continue;
    }

    if ((m = line.match(RE_FENCE))) {
      const fence = m[1];
      const lang = m[2] || '';
      const body = [];
      i += 1;
      while (i < lines.length && !(lines[i].trim().startsWith(fence[0].repeat(fence.length)) && lines[i].trim().replace(/[`~]/g, '') === '')) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // закрывающая ``` (если её ещё нет — блок идёт до конца текста)
      blocks.push({ type: 'code', lang, text: body.join('\n') });
      continue;
    }

    if ((m = line.match(RE_HEADING))) {
      blocks.push({ type: 'heading', level: m[1].length, inline: parseInline(m[2]) });
      i += 1;
      continue;
    }

    if (RE_HR.test(line)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(line).map(parseInline);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]).map(parseInline));
        i += 1;
      }
      blocks.push({ type: 'table', head, rows });
      continue;
    }

    if (RE_UL.test(line) || RE_OL.test(line)) {
      const ordered = !RE_UL.test(line);
      const start = ordered ? Number(line.match(RE_OL)[2]) : 1;
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        const um = l.match(RE_UL);
        const om = l.match(RE_OL);
        if (um || om) {
          const indent = (um ? um[1] : om[1]).replace(/\t/g, '  ').length;
          items.push({ depth: Math.min(Math.floor(indent / 2), 4), inline: um ? um[2] : om[3] });
          i += 1;
        } else if (l.trim() && /^\s{2,}/.test(l) && items.length) {
          items[items.length - 1].inline += '\n' + l.trim(); // продолжение пункта
          i += 1;
        } else {
          break;
        }
      }
      blocks.push({
        type: 'list',
        ordered,
        start,
        items: items.map((it) => ({ depth: it.depth, inline: parseInline(it.inline) })),
      });
      continue;
    }

    if (RE_QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) {
        body.push(lines[i].match(RE_QUOTE)[1]);
        i += 1;
      }
      blocks.push({ type: 'quote', blocks: parseBlocks(body.join('\n')) });
      continue;
    }

    const para = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: 'para', inline: parseInline(para.join('\n')) });
  }
  return blocks;
}

/* -------------------------------- построение DOM -------------------------------- */

function buildInline(tokens, parent, hooks) {
  for (const tk of tokens) {
    if (tk.t === 'text') parent.append(document.createTextNode(tk.v));
    else if (tk.t === 'code') {
      const c = document.createElement('code');
      c.textContent = tk.v;
      parent.append(c);
    } else if (tk.t === 'bold' || tk.t === 'italic') {
      const n = document.createElement(tk.t === 'bold' ? 'strong' : 'em');
      buildInline(tk.children, n, hooks);
      parent.append(n);
    } else if (tk.t === 'link') {
      const a = document.createElement('a');
      a.textContent = tk.text;
      a.href = tk.href;
      a.title = tk.href;
      a.onclick = (e) => {
        e.preventDefault();
        hooks.openLink?.(tk.href);
      };
      parent.append(a);
    }
  }
}

function buildBlocks(blocks, parent, hooks) {
  for (const b of blocks) {
    if (b.type === 'para') {
      const p = document.createElement('p');
      buildInline(b.inline, p, hooks);
      parent.append(p);
    } else if (b.type === 'heading') {
      const h = document.createElement(`h${Math.min(b.level + 2, 6)}`); // h1 модели → h3: не кричать
      buildInline(b.inline, h, hooks);
      parent.append(h);
    } else if (b.type === 'hr') {
      parent.append(document.createElement('hr'));
    } else if (b.type === 'quote') {
      const q = document.createElement('blockquote');
      buildBlocks(b.blocks, q, hooks);
      parent.append(q);
    } else if (b.type === 'list') {
      const list = document.createElement(b.ordered ? 'ol' : 'ul');
      if (b.ordered && b.start !== 1) list.start = b.start;
      for (const it of b.items) {
        const li = document.createElement('li');
        if (it.depth) li.style.marginLeft = `${it.depth * 18}px`;
        buildInline(it.inline, li, hooks);
        list.append(li);
      }
      parent.append(list);
    } else if (b.type === 'table') {
      const wrap = document.createElement('div');
      wrap.className = 'md-table';
      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const hr = document.createElement('tr');
      for (const cell of b.head) {
        const th = document.createElement('th');
        buildInline(cell, th, hooks);
        hr.append(th);
      }
      thead.append(hr);
      const tbody = document.createElement('tbody');
      for (const row of b.rows) {
        const tr = document.createElement('tr');
        for (const cell of row) {
          const td = document.createElement('td');
          buildInline(cell, td, hooks);
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(thead, tbody);
      wrap.append(table);
      parent.append(wrap);
    } else if (b.type === 'code') {
      const box = document.createElement('div');
      box.className = 'codeblock';
      const head = document.createElement('div');
      head.className = 'code-head';
      const lang = document.createElement('span');
      lang.textContent = b.lang || 'код';
      const copy = document.createElement('button');
      copy.className = 'ghost copy';
      copy.textContent = 'Копировать';
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(b.text);
          copy.textContent = 'Скопировано';
        } catch {
          copy.textContent = 'Не вышло';
        }
        setTimeout(() => (copy.textContent = 'Копировать'), 1500);
      };
      head.append(lang, copy);
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      for (const tk of highlightCode(b.text, b.lang)) {
        if (!tk.t) code.append(document.createTextNode(tk.v));
        else {
          const span = document.createElement('span');
          span.className = `tk-${tk.t}`;
          span.textContent = tk.v;
          code.append(span);
        }
      }
      pre.append(code);
      box.append(head, pre);
      parent.append(box);
    }
  }
}

/** Отрисовать Markdown в элемент target (старое содержимое заменяется). */
function renderMarkdownInto(target, text, hooks = {}) {
  const frag = document.createDocumentFragment();
  buildBlocks(parseBlocks(text), frag, hooks);
  target.replaceChildren(frag);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseBlocks, parseInline, highlightCode };
} else {
  window.Markdown = { renderMarkdownInto, parseBlocks, parseInline, highlightCode };
}
