'use strict';

/**
 * «Разрешать всегда»: правила, по которым инструмент не спрашивает подтверждения.
 *
 * Правило — { tool } или для run_command { tool: 'run_command', program }.
 * program — первое слово команды (путь к программе), в нижнем регистре, с «\».
 *
 * Безопасность: команда со склейкой или перенаправлением (& | ; < > ` $( перенос
 * строки) под правило не подпадает НИКОГДА — иначе «разрешённый generer.cmd &
 * del *» выполнился бы без вопроса. Такие команды всегда спрашивают.
 */

const UNSAFE = /[&|;<>`\r\n]|\$\(/;

/** Первое слово команды: "C:\Program Files\x.exe" arg → c:\program files\x.exe */
function programOf(command) {
  const m = String(command || '').match(/^\s*(?:"([^"]+)"|(\S+))/);
  if (!m) return '';
  return (m[1] || m[2]).replace(/\//g, '\\').toLowerCase();
}

function isPlainCommand(command) {
  return !UNSAFE.test(String(command || ''));
}

/** Подходит ли вызов под одно из правил. */
function isAlwaysAllowed(toolName, input, rules) {
  if (!Array.isArray(rules) || !rules.length) return false;
  for (const r of rules) {
    if (!r || r.tool !== toolName) continue;
    if (toolName !== 'run_command') return true;
    const cmd = input?.command;
    if (r.program && isPlainCommand(cmd) && programOf(cmd) === r.program) return true;
  }
  return false;
}

/**
 * Какое правило предложить для кнопки «Разрешать всегда».
 * null — для этого вызова не предлагаем (например, команда со склейкой).
 */
function suggestRule(toolName, input) {
  if (toolName === 'run_command') {
    const cmd = input?.command;
    const program = programOf(cmd);
    if (!program || !isPlainCommand(cmd)) return null;
    return { rule: { tool: 'run_command', program }, label: `команды «${program}»` };
  }
  return { rule: { tool: toolName }, label: `все вызовы ${toolName}` };
}

/** Человекочитаемая подпись правила (для списка в настройках). */
function ruleLabel(r) {
  if (r.tool === 'run_command') return `run_command: ${r.program}`;
  return r.tool;
}

function sameRule(a, b) {
  return a && b && a.tool === b.tool && (a.program || '') === (b.program || '');
}

module.exports = { programOf, isPlainCommand, isAlwaysAllowed, suggestRule, ruleLabel, sameRule };
