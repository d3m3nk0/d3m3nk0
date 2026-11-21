'use strict';

/**
 * Проверка инструментов без обращения к модели.
 * Запуск: node test/smoke.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { runTool } = require('../src/core/tools');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd3m3nk0-'));
  const ctx = { workdir: dir, allowOutside: false };
  const results = [];

  const check = (name, fn) => {
    try {
      fn();
      results.push(`ok   ${name}`);
    } catch (e) {
      results.push(`FAIL ${name}: ${e.message}`);
      process.exitCode = 1;
    }
  };

  // write_file
  await runTool('write_file', { path: 'src/hello.txt', content: 'привет\nмир\n' }, ctx);
  check('write_file создаёт файл и папки', () => {
    assert.ok(fs.existsSync(path.join(dir, 'src', 'hello.txt')));
  });

  // read_file
  const read = await runTool('read_file', { path: 'src/hello.txt' }, ctx);
  check('read_file нумерует строки', () => {
    assert.match(read, /1: привет/);
    assert.match(read, /2: мир/);
  });

  // edit_file
  const edited = await runTool('edit_file', { path: 'src/hello.txt', old_string: 'мир', new_string: 'd3m3nk0' }, ctx);
  check('edit_file заменяет фрагмент', () => {
    assert.match(edited, /заменено 1/);
    assert.match(fs.readFileSync(path.join(dir, 'src', 'hello.txt'), 'utf8'), /d3m3nk0/);
  });

  // edit_file: неоднозначность
  fs.writeFileSync(path.join(dir, 'dup.txt'), 'x\nx\n');
  let ambiguous = false;
  try {
    await runTool('edit_file', { path: 'dup.txt', old_string: 'x', new_string: 'y' }, ctx);
  } catch (e) {
    ambiguous = /встречается 2 раз/.test(e.message);
  }
  check('edit_file отказывает при неоднозначности', () => assert.ok(ambiguous));

  // list_dir
  const listed = await runTool('list_dir', { depth: 2 }, ctx);
  check('list_dir показывает дерево', () => assert.match(listed, /src\/?/));

  // glob_search
  const globbed = await runTool('glob_search', { pattern: '**/*.txt' }, ctx);
  check('glob_search находит по маске', () => {
    assert.match(globbed, /hello\.txt/);
    assert.match(globbed, /dup\.txt/);
  });

  // grep_search
  const grepped = await runTool('grep_search', { pattern: 'd3m3nk0', include: '*.txt' }, ctx);
  check('grep_search ищет по содержимому', () => assert.match(grepped, /hello\.txt:2:/));

  // run_command
  const ran = await runTool('run_command', { command: 'echo smoke-test' }, ctx);
  check('run_command возвращает stdout и код', () => {
    assert.match(ran, /exit code: 0/);
    assert.match(ran, /smoke-test/);
  });

  // защита от выхода за рабочую папку
  let blocked = false;
  try {
    await runTool('read_file', { path: path.join(os.homedir(), '.d3m3nk0', 'config.json') }, ctx);
  } catch (e) {
    blocked = /вне рабочей папки/.test(e.message);
  }
  check('read_file блокирует путь вне рабочей папки', () => assert.ok(blocked));

  // allowOutside снимает запрет
  const outsideCtx = { ...ctx, allowOutside: true };
  const outside = await runTool('read_file', { path: path.join(dir, 'src', 'hello.txt') }, outsideCtx);
  check('allowOutside работает', () => assert.match(outside, /d3m3nk0/));

  // Base URL: /v1 не должен дублироваться (обе формы дают один endpoint)
  const { endpoint } = require('../src/core/providers');
  check('Base URL без версии', () =>
    assert.strictEqual(endpoint('https://api.anthropic.com', '/v1/messages'), 'https://api.anthropic.com/v1/messages'));
  check('Base URL с /v1 (OpenRouter)', () =>
    assert.strictEqual(
      endpoint('https://openrouter.ai/api/v1', '/v1/chat/completions'),
      'https://openrouter.ai/api/v1/chat/completions'
    ));
  check('Base URL с /v1 и слэшем на конце', () =>
    assert.strictEqual(
      endpoint('http://localhost:1234/v1/', '/v1/chat/completions'),
      'http://localhost:1234/v1/chat/completions'
    ));

  console.log(results.join('\n'));
  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
