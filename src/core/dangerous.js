'use strict';

/**
 * Опасные вызовы, которые требуют подтверждения ВСЕГДА — раньше режима
 * (включая yolo) и раньше правила «Разрешать всегда».
 *
 * Список живёт здесь, agent.js только спрашивает isDangerous(). Три класса:
 *   1. рекурсивное удаление;
 *   2. скачивание и запуск одной командой (curl … | iex и т.п.);
 *   3. запись вне рабочей папки в C:\Windows, Program Files и корень C:\.
 *
 * Это не полноценный разбор shell, а защита от типовых разрушительных форм.
 * Лучше лишний раз спросить, чем молча выполнить `rm -rf` в yolo.
 */

const path = require('node:path');

const PROTECTED_DIRS = ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)'];

// 1. Рекурсивное удаление. Флаги могут стоять в любом порядке и после пути.
const DELETE_PATTERNS = [
  /\bremove-item\b[^|;&\r\n]*\s-rec[a-z]*\b/i,
  /\brm\b[^|;&\r\n]*\s(?:-[a-z]*r[a-z]*|--recursive)\b/i,
  /\b(?:rd|rmdir)\b[^|;&\r\n]*\s\/s\b/i,
  /\b(?:del|erase)\b[^|;&\r\n]*\s\/s\b/i,
  /\b(?:format(?:\.com)?\s+[a-z]:|format-volume\b)/i,
];

// 2. Скачивание и запуск одной командой: `curl … | sh`, `iwr … | iex`,
//    а также обёртка `iex (iwr …)`.
const DOWNLOAD_EXEC = [
  /\b(?:curl(?:\.exe)?|wget(?:\.exe)?|iwr(?:\.exe)?|invoke-webrequest)\b[^\r\n]*\|\s*(?:iex|invoke-expression|sh|bash|zsh|powershell|pwsh)\b/i,
  /\b(?:iex|invoke-expression)\s*\(\s*(?:curl(?:\.exe)?|wget(?:\.exe)?|iwr(?:\.exe)?|invoke-webrequest)\b/i,
];

// 3. Признаки записи в команде: перенаправление или пишущая утилита.
//    Сама по себе запись безопасна — важен путь рядом с ней.
const WRITE_HINTS =
  />|\b(?:set-content|add-content|out-file|new-item|copy-item|move-item|rename-item|remove-item|copy|robocopy|xcopy|move|ren(?:ame)?|mkdir|md|ni|tee|cp|mv|install|scp|del|erase|rmdir|rd|rm|curl|wget|iwr|invoke-webrequest|invoke-restmethod|start-bitstransfer|expand-archive|7z|unzip|tar|writeall[a-z]*|appendall[a-z]*)\b/i;

// Пути вида C:\… внутри строки команды. Пробелы режут путь (для
// «C:\Program Files\…» это даёт C:\Program — тоже защищённый корень).
const WINDOWS_PATH = /[a-z]:\\[^\s"'<>|;&)]*/gi;

/** Лежит ли target внутри dir (пути Windows, без учёта регистра). */
function within(dir, target) {
  const d = path.win32.resolve(String(dir || '.')).toLowerCase();
  const t = path.win32.resolve(String(target || '.')).toLowerCase();
  const rel = path.win32.relative(d, t);
  return rel === '' || (!rel.startsWith('..') && !path.win32.isAbsolute(rel));
}

/** Запись в защищённый каталог или в первый уровень корня C:\ вне рабочей папки. */
function isProtectedTarget(target, workdir) {
  if (!target) return false;
  if (workdir && within(workdir, target)) return false;
  const t = path.win32.resolve(String(target)).toLowerCase();
  for (const dir of PROTECTED_DIRS) {
    if (t === dir || t.startsWith(`${dir}\\`)) return true;
  }
  const root = path.win32.parse(t).root;
  return root === 'c:\\' && path.win32.dirname(t) === root;
}

/** Все абсолютные Windows-пути, упомянутые в команде. */
function pathsIn(command) {
  const text = String(command || '').replace(/\//g, '\\');
  return (text.match(WINDOWS_PATH) || []).map((p) => p.replace(/[.,;:]+$/, ''));
}

function writesProtected(command, workdir) {
  const text = String(command || '');
  if (!WRITE_HINTS.test(text)) return false;
  return pathsIn(text).some((p) => isProtectedTarget(p, workdir));
}

/**
 * Требует ли вызов подтверждения всегда.
 * workdir — рабочая папка агента; запись внутри неё опасной не считается,
 * даже если она лежит в C:\Windows (например, песочница в C:\Windows\Temp).
 */
function isDangerous(toolName, input, workdir) {
  if (toolName === 'run_command') {
    const command = String(input?.command || '');
    if (DELETE_PATTERNS.some((re) => re.test(command))) return true;
    if (DOWNLOAD_EXEC.some((re) => re.test(command))) return true;
    return writesProtected(command, workdir);
  }
  if (toolName === 'write_file' || toolName === 'edit_file') {
    if (!input?.path) return false;
    const target = path.win32.resolve(String(workdir || '.'), String(input.path));
    return isProtectedTarget(target, workdir);
  }
  return false;
}

module.exports = { isDangerous, PROTECTED_DIRS, DELETE_PATTERNS, DOWNLOAD_EXEC };
