'use strict';

/**
 * Чистка тестовых сессий — прогонов проверок, которые засоряют список слева.
 *
 *   node scripts/clean-test-sessions.js            dry-run: показать кандидатов и выйти
 *   node scripts/clean-test-sessions.js --delete   удалить кандидатов (без корзины!)
 *
 * Сессия тестовая, только если в ней есть сообщения пользователя и ВСЕ они
 * дословно совпадают с одной из строк TEST_PROMPTS. Одна «живая» фраза — и
 * сессия остаётся. Совпадение точное, а не по началу: «Напиши подробный
 * рассказ о том, как агент…» — не тестовая строка и под чистку не попадает.
 *
 * Папка сессий — SESSIONS_DIR из src/core/config.js (меняется через D3M3NK0_HOME).
 * Скрипт её не создаёт.
 */

const fs = require('node:fs');
const path = require('node:path');
const { SESSIONS_DIR } = require('../src/core/config');

/** Дословные формулировки тестовых прогонов — взяты из самих файлов сессий. */
const TEST_PROMPTS = new Set([
  // проверки вызова инструментов и стриминга
  'Через list_dir посмотри src/core и одной строкой перечисли js-файлы.',
  'вызови list_dir и опиши результат',
  'вызови list_dir для src/core и опиши результат',
  'Сначала одной фразой скажи, что сейчас посмотришь папку. Потом вызови list_dir для src/core. Потом в двух предложениях опиши, какие там файлы.',
  'Сначала одной фразой скажи, что сейчас посмотришь папку. Потом вызови list_dir для src/core. Потом одним предложением опиши результат.',
  'Перечисли js-файлы в src/core одной строкой.',
  // сценарий B и проверки окна
  'Ответь одним словом: ок',
  'Привет, напиши одну фразу',
  // проверки «Стоп» и Ctrl+C
  'Напиши подробный рассказ из десяти абзацев о маяке на скалистом берегу.',
  'Напиши подробный рассказ из десяти абзацев о маяке.',
  'Write a detailed story of ten long paragraphs about a lighthouse keeper.',
  // проверки усечения контекста
  'Прочитай файл src/core/providers.js через read_file и ответь одной фразой, что в нём.',
  'Не вызывая инструментов, по уже прочитанному: какая самая последняя строка файла providers.js? Процитируй её. И видел ли ты файл целиком?',
  'Открой через REA бинарник C:\\Users\\ele8e\\d3m3nk0\\deepseek-harness-0.2.2-rc.5-win-x64.exe (open_binary) и вызови list_strings без лимита. Ответь одной фразой: сколько строк нашлось.',
  'Не вызывая инструментов, по уже полученному выводу list_strings: назови первые три строки из списка и скажи, видишь ли ты весь вывод или только часть.',
]);

/** Тексты сообщений пользователя (результаты инструментов не считаются). */
function userTexts(file) {
  const texts = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let m;
    try {
      m = JSON.parse(line).entry?.message;
    } catch {
      continue; // битая строка — как в Session.load
    }
    if (!m || m.role !== 'user') continue;
    const text = (m.blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (text) texts.push(text);
  }
  return texts;
}

const fmtSize = (bytes) => (bytes < 1024 ? `${bytes} Б` : `${(bytes / 1024).toFixed(1)} КБ`);

function main() {
  const doDelete = process.argv.includes('--delete');

  let names;
  try {
    names = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.jsonl')).sort();
  } catch (e) {
    const why = e.code === 'ENOENT' ? 'папка не существует' : e.code === 'EACCES' || e.code === 'EPERM' ? 'нет доступа' : e.message;
    throw new Error(`Не удалось прочитать ${SESSIONS_DIR}: ${why}`);
  }
  if (!names.length) {
    console.log(`Сессий нет в ${SESSIONS_DIR} — чистить нечего.`);
    return;
  }

  const candidates = [];
  let keptBytes = 0;
  for (const name of names) {
    const file = path.join(SESSIONS_DIR, name);
    let texts;
    let size;
    try {
      texts = userTexts(file);
      size = fs.statSync(file).size;
    } catch (e) {
      throw new Error(`Не удалось прочитать ${file}: ${e.code === 'EACCES' || e.code === 'EPERM' ? 'нет доступа' : e.message}`);
    }
    // Пустая сессия (нет сообщений пользователя) — не тестовая: её происхождение неизвестно.
    const isTest = texts.length > 0 && texts.every((t) => TEST_PROMPTS.has(t));
    if (isTest) candidates.push({ id: name.replace(/\.jsonl$/, ''), file, size, first: texts[0], turns: texts.length });
    else keptBytes += size;
  }

  const freed = candidates.reduce((n, c) => n + c.size, 0);
  console.log(`\nПапка: ${SESSIONS_DIR}`);
  console.log(`Всего сессий: ${names.length}. Тестовых: ${candidates.length}. Останется: ${names.length - candidates.length}.\n`);
  for (const c of candidates) {
    console.log(`  ${c.id}  ${fmtSize(c.size).padStart(8)}  ${c.turns > 1 ? `[${c.turns} сообщ.] ` : ''}${c.first.slice(0, 70)}`);
  }
  console.log(`\nОсвободится: ${fmtSize(freed)}. Останется: ${fmtSize(keptBytes)}.`);

  if (!candidates.length) return;
  if (!doDelete) {
    console.log('\nЭто dry-run: ничего не удалено. Удалить: node scripts/clean-test-sessions.js --delete (без корзины).');
    return;
  }

  let removed = 0;
  for (const c of candidates) {
    try {
      fs.unlinkSync(c.file);
      removed++;
    } catch (e) {
      throw new Error(`Удалено ${removed} из ${candidates.length}; не удалось удалить ${c.file}: ${e.code === 'EACCES' || e.code === 'EPERM' ? 'нет доступа' : e.message}`);
    }
  }
  console.log(`\nУдалено: ${removed}.`);
}

try {
  main();
} catch (e) {
  console.error(`Ошибка: ${e.message}`);
  process.exit(1);
}
