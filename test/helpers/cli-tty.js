'use strict';

/**
 * Запуск настоящего cli.js с эмулированным ТЕРМИНАЛОМ — для регрессионных тестов.
 *
 * stdin и stdout подменяются объектами с isTTY = true: readline работает в
 * raw-режиме, и Ctrl+C приходит байтом \x03 — тем же путём, что в консоли
 * Windows (событие SIGINT у readline-интерфейса).
 *
 *   node test/helpers/cli-tty.js '<сценарий JSON>'
 *
 * Сценарий — массив шагов { after, delay, send }: дождаться, пока вывод с
 * момента прошлого шага совпадёт с регэкспом after, подождать delay мс,
 * «нажать» send. Папку настроек и сессий задаёт родитель через D3M3NK0_HOME.
 *
 * Наружу (в stderr, fd 2) — строки с префиксом @@ и JSON:
 *   {"t":мс,"out":"..."}   запись CLI в stdout
 *   {"t":мс,"sent":"..."}  отправленное нажатие
 *   {"t":мс,"exit":код}    выход процесса
 */

const fs = require('node:fs');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');

const steps = JSON.parse(process.argv[2] || '[]');
const t0 = Date.now();
const report = (o) => fs.writeSync(2, `@@${JSON.stringify({ t: Date.now() - t0, ...o })}\n`);

const fakeIn = new PassThrough();
fakeIn.isTTY = true;
fakeIn.isRaw = false;
fakeIn.setRawMode = (v) => {
  fakeIn.isRaw = v;
  return fakeIn;
};

let sinceStep = '';
let onOutput = () => {};
const fakeOut = new Writable({
  write(chunk, _enc, cb) {
    const s = String(chunk);
    sinceStep += s;
    report({ out: s });
    onOutput();
    cb();
  },
});
fakeOut.isTTY = true;
fakeOut.columns = 120;
fakeOut.rows = 40;

Object.defineProperty(process, 'stdin', { value: fakeIn, configurable: true });
Object.defineProperty(process, 'stdout', { value: fakeOut, configurable: true });
console.log = (...a) => fakeOut.write(a.join(' ') + '\n');
console.error = (...a) => fakeOut.write(a.join(' ') + '\n');
process.on('exit', (code) => report({ exit: code }));

async function runSteps() {
  for (const step of steps) {
    const re = new RegExp(step.after || '');
    await new Promise((resolve) => {
      const check = () => {
        if (re.test(sinceStep)) {
          onOutput = () => {};
          resolve();
        }
      };
      onOutput = check;
      check();
    });
    await new Promise((r) => setTimeout(r, step.delay || 0));
    sinceStep = '';
    report({ sent: step.send });
    fakeIn.write(step.send);
  }
}

process.argv = [process.argv[0], path.join(__dirname, '..', '..', 'cli.js')];
require('../../cli.js');
runSteps();
