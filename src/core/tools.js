'use strict';

/**
 * Встроенные инструменты агента.
 *
 * Каждый инструмент: { name, description, input_schema, run(input, ctx) }.
 * input_schema — обычный JSON Schema, он же уходит в API модели.
 * ctx: { workdir, allowOutside, signal }
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_OUTPUT = 30000; // символов на результат инструмента
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.venv', '__pycache__', '.cache']);

// Картинки для view_image. Отправляем модели не больше IMAGE_MAX_SEND
// (у Anthropic предел 5 МБ на картинку); в окне большие уменьшаются до
// IMAGE_MAX_SIDE по длинной стороне — модели крупнее и не нужно.
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const IMAGE_MAX_READ = 40 * 1048576;
const IMAGE_MAX_SEND = 4.5 * 1048576;
const IMAGE_SHRINK_BYTES = 1.5 * 1048576;
const IMAGE_MAX_SIDE = 1600;

// read_pdf: за один вызов не больше PDF_MAX_PAGES страниц, без pages — первые
// PDF_DEFAULT_PAGES. Курс RDM — по 30–60 страниц: целиком он съел бы лимит.
const PDF_MAX_PAGES = 20;
const PDF_DEFAULT_PAGES = 10;

/**
 * Разобрать «1-5, 8, 10-12» в список номеров страниц (по порядку, без повторов).
 * Ошибка — если номер вне 1..total или страниц больше PDF_MAX_PAGES.
 */
function parsePages(spec, total) {
  if (spec == null || String(spec).trim() === '') {
    return Array.from({ length: Math.min(total, PDF_DEFAULT_PAGES) }, (_, i) => i + 1);
  }
  const set = new Set();
  for (const part of String(spec).split(',')) {
    const m = part.trim().match(/^(\d+)\s*(?:[-–]\s*(\d+))?$/);
    if (!m) throw new Error(`Не понял страницы «${part.trim()}». Пример: "1-5, 8"`);
    const a = Number(m[1]);
    // «1-3» у PDF из одной страницы — не ошибка: отдаём то, что есть.
    const b = Math.min(m[2] ? Number(m[2]) : a, total);
    if (a < 1 || a > total || a > b) throw new Error(`Страница ${a} вне документа (в нём ${total} стр.)`);
    for (let n = a; n <= b; n++) set.add(n);
    if (set.size > PDF_MAX_PAGES) throw new Error(`За раз можно не больше ${PDF_MAX_PAGES} страниц — разбейте на части`);
  }
  return [...set].sort((x, y) => x - y);
}

/** «1, 2, 3, 5» → «1–3, 5» для подписи. */
function pagesLabel(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    let j = i;
    while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
    out.push(i === j ? `${list[i]}` : `${list[i]}–${list[j]}`);
    i = j;
  }
  return out.join(', ');
}

function truncate(text, max = MAX_OUTPUT) {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  return `${head}\n\n[...обрезано: показано ${max} из ${text.length} символов]`;
}

function resolvePath(input, ctx) {
  const raw = input && input.path ? input.path : '.';
  const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(ctx.workdir, raw);
  const rel = path.relative(ctx.workdir, abs);
  const outside = rel.startsWith('..') || path.isAbsolute(rel);
  if (outside && !ctx.allowOutside) {
    throw new Error(
      `Путь вне рабочей папки: ${abs}. Рабочая папка: ${ctx.workdir}. ` +
        `Разрешите доступ вне неё в настройках, если это действительно нужно.`
    );
  }
  return abs;
}

async function* walk(dir, depth = 0, maxDepth = 8) {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield { type: 'dir', path: full, name: e.name };
      yield* walk(full, depth + 1, maxDepth);
    } else if (e.isFile()) {
      yield { type: 'file', path: full, name: e.name };
    }
  }
}

/**
 * Glob -> RegExp.
 * Поддерживает *, ?, ** и **\/ (ноль или больше папок).
 */
function toGlobRegex(pattern) {
  const src = String(pattern).replace(/\\/g, '/');
  let out = '^';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '*') {
      if (src[i + 1] === '*') {
        if (src[i + 2] === '/') {
          out += '(?:.*/)?'; // **/ — ноль или больше папок
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(out + '$', 'i');
}

const tools = [
  {
    name: 'read_file',
    description:
      'Прочитать текстовый файл. Возвращает содержимое с номерами строк. ' +
      'Используй offset/limit для больших файлов.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к файлу (относительно рабочей папки или абсолютный)' },
        offset: { type: 'integer', description: 'С какой строки начать (1-based)' },
        limit: { type: 'integer', description: 'Сколько строк вернуть' },
      },
      required: ['path'],
    },
    async run(input, ctx) {
      const file = resolvePath(input, ctx);
      const text = await fsp.readFile(file, 'utf8');
      const lines = text.split('\n');
      const offset = Math.max(1, input.offset || 1);
      const limit = input.limit || 2000;
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = slice.map((l, i) => `${String(offset + i).padStart(5)}: ${l}`).join('\n');
      const note = slice.length < lines.length - (offset - 1) ? `\n[...строки ${offset}-${offset + slice.length - 1} из ${lines.length}]` : '';
      return truncate(numbered + note);
    },
  },
  {
    name: 'write_file',
    description: 'Создать файл или полностью перезаписать существующий. Родительские папки создаются автоматически.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к файлу' },
        content: { type: 'string', description: 'Новое содержимое целиком' },
      },
      required: ['path', 'content'],
    },
    async run(input, ctx) {
      const file = resolvePath(input, ctx);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, input.content ?? '', 'utf8');
      return `Записан ${file} (${Buffer.byteLength(input.content ?? '', 'utf8')} байт)`;
    },
  },
  {
    name: 'edit_file',
    description:
      'Точечная замена в файле: найти old_string и заменить на new_string. ' +
      'old_string должен встречаться ровно один раз, иначе используй replace_all.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string', description: 'Точный фрагмент для замены' },
        new_string: { type: 'string', description: 'Чем заменить' },
        replace_all: { type: 'boolean', description: 'Заменить все вхождения' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async run(input, ctx) {
      const file = resolvePath(input, ctx);
      // Пустой old_string «находится» везде: с replace_all он разрезал бы файл
      // по каждой букве, поэтому такой вызов отвергаем сразу.
      if (!String(input.old_string ?? '')) throw new Error('old_string пуст — нечего заменять');
      const text = await fsp.readFile(file, 'utf8');
      const count = text.split(input.old_string).length - 1;
      if (count === 0) throw new Error('old_string не найден в файле');
      if (count > 1 && !input.replace_all) {
        throw new Error(`old_string встречается ${count} раз; уточни фрагмент или включи replace_all`);
      }
      // Замена функцией, а не строкой: в new_string символы $& $` $' $1 — это
      // шаблоны String.replace, и код вроде "цена: $&" молча превратился бы
      // в копию old_string.
      const next = input.replace_all
        ? text.split(input.old_string).join(input.new_string)
        : text.replace(input.old_string, () => input.new_string);
      await fsp.writeFile(file, next, 'utf8');
      return `Изменён ${file}: заменено ${input.replace_all ? count : 1} вхождений`;
    },
  },
  {
    name: 'list_dir',
    description: 'Показать содержимое папки (по умолчанию рабочей) в виде дерева.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Папка, по умолчанию рабочая' },
        depth: { type: 'integer', description: 'Глубина, по умолчанию 2' },
      },
    },
    async run(input, ctx) {
      const root = resolvePath(input, ctx);
      const depth = Math.min(Math.max(input.depth ?? 2, 1), 8);
      const out = [];
      const base = path.relative(ctx.workdir, root) || '.';
      out.push(base + '/');
      for await (const item of walk(root, 0, depth)) {
        const rel = path.relative(root, item.path);
        const level = rel.split(path.sep).length;
        if (level > depth) continue;
        out.push(`${'  '.repeat(level)}${item.name}${item.type === 'dir' ? '/' : ''}`);
      }
      return truncate(out.join('\n'));
    },
  },
  {
    name: 'glob_search',
    description: 'Найти файлы по glob-шаблону, например "**/*.js" или "src/**/*.py".',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob-шаблон относительно папки поиска' },
        path: { type: 'string', description: 'Где искать, по умолчанию рабочая папка' },
      },
      required: ['pattern'],
    },
    async run(input, ctx) {
      const root = resolvePath(input, ctx);
      const re = toGlobRegex(input.pattern);
      const hits = [];
      for await (const item of walk(root)) {
        if (item.type !== 'file') continue;
        const rel = path.relative(root, item.path).split(path.sep).join('/');
        if (re.test(rel) || re.test(item.name)) hits.push(rel);
        if (hits.length >= 500) break;
      }
      if (!hits.length) return 'Совпадений нет';
      return truncate(hits.sort().join('\n'));
    },
  },
  {
    name: 'grep_search',
    description: 'Поиск по содержимому файлов регулярным выражением (JS RegExp, без флагов).',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Регулярное выражение' },
        path: { type: 'string', description: 'Где искать, по умолчанию рабочая папка' },
        include: { type: 'string', description: 'Glob-фильтр имён файлов, например "*.js"' },
        max_results: { type: 'integer', description: 'Предел совпадений, по умолчанию 100' },
      },
      required: ['pattern'],
    },
    async run(input, ctx) {
      const root = resolvePath(input, ctx);
      const re = new RegExp(input.pattern);
      const include = input.include ? toGlobRegex(input.include) : null;
      const max = Math.min(input.max_results || 100, 500);
      const out = [];
      for await (const item of walk(root)) {
        if (item.type !== 'file') continue;
        const rel = path.relative(root, item.path).split(path.sep).join('/');
        if (include && !(include.test(rel) || include.test(item.name))) continue;
        let text;
        try {
          const st = await fsp.stat(item.path);
          if (st.size > 2_000_000) continue; // не читаем гигантов
          text = await fsp.readFile(item.path, 'utf8');
        } catch {
          continue;
        }
        if (text.includes('\u0000')) continue; // бинарный
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            out.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
            if (out.length >= max) return truncate(out.join('\n') + `\n[...достигнут предел ${max}]`);
          }
        }
      }
      return out.length ? truncate(out.join('\n')) : 'Совпадений нет';
    },
  },
  {
    name: 'run_command',
    description:
      'Выполнить команду оболочки в рабочей папке. Возвращает stdout, stderr и код выхода. ' +
      'Долгие команды ограничены таймаутом.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Команда целиком' },
        timeout_ms: { type: 'integer', description: 'Таймаут, по умолчанию 60000' },
        cwd: { type: 'string', description: 'Рабочая папка команды, по умолчанию рабочая папка агента' },
      },
      required: ['command'],
    },
    async run(input, ctx) {
      const cwd = input.cwd ? resolvePath({ path: input.cwd }, ctx) : ctx.workdir;
      const timeout = Math.min(input.timeout_ms || 60000, 600000);
      return await new Promise((resolve) => {
        const isWin = process.platform === 'win32';
        const child = spawn(input.command, {
          cwd,
          shell: isWin ? true : '/bin/sh',
          windowsHide: true,
          env: process.env,
        });
        let stdout = '';
        let stderr = '';
        let killed = false;
        const timer = setTimeout(() => {
          killed = true;
          child.kill();
        }, timeout);
        child.stdout.on('data', (d) => {
          if (stdout.length < MAX_OUTPUT * 2) stdout += d.toString();
        });
        child.stderr.on('data', (d) => {
          if (stderr.length < MAX_OUTPUT * 2) stderr += d.toString();
        });
        child.on('error', (e) => {
          clearTimeout(timer);
          resolve(`Не удалось запустить команду: ${e.message}`);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          const parts = [`exit code: ${code}${killed ? ' (таймаут)' : ''}`];
          if (stdout.trim()) parts.push(`stdout:\n${truncate(stdout.trim())}`);
          if (stderr.trim()) parts.push(`stderr:\n${truncate(stderr.trim())}`);
          resolve(parts.join('\n'));
        });
      });
    },
  },

  {
    name: 'read_pdf',
    description:
      'Прочитать текст из PDF в рабочей папке (курсы, задачи, формуляры). Читай частями: ' +
      `pages — например "1-5, 8" (за раз до ${PDF_MAX_PAGES} страниц; без pages — первые ${PDF_DEFAULT_PAGES}). ` +
      'Рисунки и сканы так не читаются — для них сохрани страницу картинкой и используй view_image.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к PDF (относительно рабочей папки)' },
        pages: { type: 'string', description: 'Страницы: "3", "1-5", "1-5, 8, 10-12"' },
      },
      required: ['path'],
    },
    async run(input, ctx) {
      const abs = resolvePath(input, ctx);
      if (path.extname(abs).toLowerCase() !== '.pdf') throw new Error(`Это не PDF: ${path.basename(abs)}`);
      const data = new Uint8Array(await fsp.readFile(abs));
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const task = pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true, verbosity: 0 });
      try {
        const doc = await task.promise;
        const total = doc.numPages;
        const list = parsePages(input.pages, total);
        const rel = path.relative(ctx.workdir, abs) || path.basename(abs);
        const parts = [`PDF ${rel}: ${total} стр. Показаны страницы ${pagesLabel(list)}.`];
        for (const n of list) {
          if (ctx.signal?.aborted) throw new Error('прервано');
          const content = await (await doc.getPage(n)).getTextContent();
          let text = '';
          for (const it of content.items) text += (it.str || '') + (it.hasEOL ? '\n' : ' ');
          text = text.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
          parts.push(`--- страница ${n} ---\n${text || '(текста нет — скан или рисунок; используй view_image)'}`);
        }
        const last = list[list.length - 1];
        if (last < total) {
          const next = `${last + 1}-${Math.min(total, last + PDF_DEFAULT_PAGES)}`;
          parts.push(`[Дальше есть ещё страницы. Продолжить: read_pdf с pages "${next}"]`);
        }
        return truncate(parts.join('\n\n'));
      } finally {
        await task.destroy().catch(() => {});
      }
    },
  },

  {
    name: 'view_image',
    description:
      'Посмотреть картинку из рабочей папки (png, jpg, jpeg, gif, webp): модель увидит её содержимое. ' +
      'Для схем и рисунков задач, фото, скриншотов. Не превращай картинку в base64 сам — вызывай этот инструмент.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Путь к картинке (относительно рабочей папки)' } },
      required: ['path'],
    },
    async run(input, ctx) {
      const abs = resolvePath(input, ctx);
      const ext = path.extname(abs).toLowerCase();
      const mediaType = IMAGE_TYPES[ext];
      if (!mediaType) throw new Error(`Не картинка или формат не поддержан: ${ext || 'без расширения'}. Можно: ${Object.keys(IMAGE_TYPES).join(', ')}`);
      const stat = await fsp.stat(abs);
      if (!stat.isFile()) throw new Error(`Это не файл: ${abs}`);
      if (stat.size > IMAGE_MAX_READ) throw new Error(`Картинка слишком большая: ${Math.round(stat.size / 1048576)} МБ (предел ${IMAGE_MAX_READ / 1048576} МБ)`);

      let data = await fsp.readFile(abs);
      let type = mediaType;
      let note = '';
      // В окне Electron большие картинки уменьшаются (nativeImage); в CLI — как есть.
      const resized = ctx.resizeImage ? await ctx.resizeImage(data, { maxSide: IMAGE_MAX_SIDE, maxBytes: IMAGE_SHRINK_BYTES }) : null;
      if (resized) {
        data = resized.data;
        type = resized.mediaType;
        note = `, уменьшена до ${resized.width}×${resized.height}`;
      }
      if (data.length > IMAGE_MAX_SEND) {
        throw new Error(
          `Картинка ${Math.round(data.length / 1048576)} МБ — больше ${IMAGE_MAX_SEND / 1048576} МБ, модели её не отправить. Уменьшите её или откройте агента в окне (там картинки уменьшаются сами).`,
        );
      }
      const rel = path.relative(ctx.workdir, abs) || path.basename(abs);
      return {
        // Модели нужно однозначно: изображение — это файл, который она открыла сама,
        // а не вставка пользователя; пользователь видит то же превью в окне.
        text:
          `Файл ${rel} открыт (${Math.round(data.length / 1024)} КБ${note}). Его изображение передано тебе вместе с этим ` +
          `результатом — ты его видишь. Пользователь видит ту же картинку в карточке инструмента. ` +
          `Мелкий текст читай осторожно: если не уверен в цифрах или буквах, так и скажи, не додумывай.`,
        image: { media_type: type, data: data.toString('base64'), path: rel, bytes: data.length },
      };
    },
  },
];

const byName = new Map(tools.map((t) => [t.name, t]));

function toolSchemas(extra = []) {
  return [...tools, ...extra].map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

async function runTool(name, input, ctx, extra = []) {
  const tool = byName.get(name) || extra.find((t) => t.name === name);
  if (!tool) throw new Error(`Неизвестный инструмент: ${name}`);
  return await tool.run(input, ctx);
}

module.exports = { tools, toolSchemas, runTool, resolvePath, truncate, parsePages, MAX_OUTPUT, IMAGE_MAX_SEND, IMAGE_MAX_SIDE, PDF_MAX_PAGES };
