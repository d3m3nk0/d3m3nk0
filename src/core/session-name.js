'use strict';

/**
 * Короткое имя сессии из первого сообщения пользователя — локально, без модели.
 *
 *   «Привет! Помоги решить задачу на кручение вала» → privet_pomogi_reshit_zadachu_na
 *
 * Правила:
 *  - слова — куски текста между пробелами; кусок, где после чистки ничего не
 *    осталось (например «!!!» или «—»), словом не считается;
 *  - берём первые 5 слов; если слов меньше 3 — оставляем сколько есть (1–2);
 *  - нижний регистр, слова соединяются «_», остаются только a–z, 0–9 и «_»;
 *  - имя не длиннее NAME_MAX символов (обрезается по границе слова);
 *  - ни одного слова → null (в списке тогда показывается начало сообщения).
 *
 * Кириллица ТРАНСЛИТЕРИРУЕТСЯ, а не убирается: пользователь пишет агенту
 * по-русски, и при удалении кириллицы почти все имена оказались бы пустыми.
 * Схема простая, «паспортная» (щ → shch, ж → zh, ю → yu, ъ и ь — без звука),
 * плюс украинские і, ї, є, ґ. Латинские буквы с диакритикой (французское
 * résistance) приводятся к базовой букве: resistance.
 */

const MIN_WORDS = 3;
const MAX_WORDS = 5;
const NAME_MAX = 60;

const CYR = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  і: 'i', ї: 'yi', є: 'ye', ґ: 'g',
};

/** Кириллица → латиница, диакритика → базовая буква. Регистр уже нижний. */
function translit(word) {
  let out = '';
  for (const ch of word) out += Object.hasOwn(CYR, ch) ? CYR[ch] : ch;
  // é → e + ◌́ → e: убираем комбинируемые знаки после разложения NFD.
  return out.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Одно слово: транслит и только a–z, 0–9, «_» (без «_» по краям). */
function cleanWord(token) {
  return translit(token.toLowerCase())
    .replace(/[^a-z0-9_]+/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Имя сессии из текста первого сообщения.
 * @returns {string|null}
 */
function sessionName(text) {
  const words = [];
  for (const token of String(text ?? '').split(/\s+/)) {
    const w = cleanWord(token);
    if (w) words.push(w);
    if (words.length === MAX_WORDS) break;
  }
  if (!words.length) return null;
  // Меньше MIN_WORDS слов — оставляем как есть: «privet» лучше пустого имени.
  let name = words.join('_');
  if (name.length > NAME_MAX) {
    const cut = name.slice(0, NAME_MAX);
    const lastSep = cut.lastIndexOf('_');
    name = lastSep > 0 ? cut.slice(0, lastSep) : cut;
  }
  return name;
}

module.exports = { sessionName, translit, MIN_WORDS, MAX_WORDS, NAME_MAX };
