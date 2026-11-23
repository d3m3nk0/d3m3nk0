'use strict';

/**
 * Вложения в чат: вставленный скриншот (Ctrl+V) или перетащенный файл.
 *
 * Файл попадает в рабочую папку агента, в подпапку «Вложения», под именем с
 * датой — чтобы агент мог открыть его своими инструментами (view_image,
 * read_pdf, read_file) и не выходил за границы рабочей папки. Файл, который
 * уже лежит в рабочей папке, не копируется.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const DIR = 'Вложения';
const MAX_BYTES = 25 * 1048576;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

function kindOf(name) {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  return 'file';
}

/** Имя без запрещённых в Windows символов, с префиксом даты: 20261123-081500-скрин.png */
function safeName(name, now = new Date()) {
  const base = path.basename(String(name || 'вложение')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(-120) || 'вложение';
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${base}`;
}

/** Свободное имя в папке: при совпадении добавляется (2), (3)… */
function uniquePath(dir, name) {
  let p = path.join(dir, name);
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${stem} (${i})${ext}`);
  return p;
}

function describe(workdir, abs, bytes) {
  const rel = path.relative(workdir, abs);
  return { rel, abs, kind: kindOf(abs), bytes, name: path.basename(abs) };
}

/** Сохранить байты (вставленный скриншот). */
async function saveBytes({ workdir, name, data }) {
  const buf = Buffer.from(data);
  if (!buf.length) throw new Error('Пустое вложение');
  if (buf.length > MAX_BYTES) throw new Error(`Вложение больше ${MAX_BYTES / 1048576} МБ`);
  const dir = path.join(workdir, DIR);
  await fsp.mkdir(dir, { recursive: true });
  const abs = uniquePath(dir, safeName(name));
  await fsp.writeFile(abs, buf);
  return describe(workdir, abs, buf.length);
}

/** Перетащенный файл: из рабочей папки — как есть, снаружи — копия во «Вложения». */
async function attachFile({ workdir, src }) {
  const st = await fsp.stat(src);
  if (!st.isFile()) throw new Error(`Это не файл: ${path.basename(src)}`);
  if (st.size > MAX_BYTES) throw new Error(`Файл больше ${MAX_BYTES / 1048576} МБ: ${path.basename(src)}`);
  const rel = path.relative(workdir, src);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return describe(workdir, path.resolve(src), st.size);
  const dir = path.join(workdir, DIR);
  await fsp.mkdir(dir, { recursive: true });
  const abs = uniquePath(dir, safeName(path.basename(src)));
  await fsp.copyFile(src, abs);
  return describe(workdir, abs, st.size);
}

// Чем открыть вложение — одна формулировка на ядро и на окно: окно берёт
// готовую подсказку из ответа attach:bytes/attach:file, чтобы тексты не разъехались.
const NOTE = {
  image: 'картинка — открой через view_image',
  pdf: 'PDF — читай через read_pdf',
  file: 'файл — read_file',
};

function noteFor(kind) {
  return NOTE[kind] || NOTE.file;
}

/** Текст для сообщения: какие вложения и чем их открыть. */
function attachmentNote(list) {
  if (!list?.length) return '';
  return `\n\nВложения:\n${list.map((a) => `- ${a.rel} (${noteFor(a.kind)})`).join('\n')}`;
}

module.exports = { saveBytes, attachFile, attachmentNote, noteFor, kindOf, safeName, DIR, MAX_BYTES };
