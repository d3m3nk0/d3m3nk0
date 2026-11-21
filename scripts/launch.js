'use strict';

/**
 * Запуск d3m3nk0 с доверием системному хранилищу сертификатов.
 *
 * Антивирус или корпоративный прокси подменяет TLS своим корневым
 * сертификатом. Windows и Chrome ему доверяют, а Node — нет: он использует
 * собственный набор CA и падает с SELF_SIGNED_CERT_IN_CHAIN. Переменная
 * NODE_USE_SYSTEM_CA=1 переключает Node на хранилище ОС.
 *
 * Она читается только при старте процесса, поэтому выставить её изнутри
 * приложения нельзя — отсюда эта обёртка.
 *
 *   node scripts/launch.js app            десктопное окно
 *   node scripts/launch.js cli [запрос]   терминальный режим
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const mode = process.argv[2] || 'app';
const root = path.join(__dirname, '..');

const env = { ...process.env };
if (!env.NODE_USE_SYSTEM_CA) env.NODE_USE_SYSTEM_CA = '1';

const isCli = mode === 'cli';
const command = isCli ? process.execPath : require('electron');
const args = isCli ? [path.join(root, 'cli.js'), ...process.argv.slice(3)] : [root];

const child = spawn(command, args, { stdio: 'inherit', env, cwd: process.cwd() });
child.on('close', (code) => process.exit(code ?? 0));
child.on('error', (e) => {
  console.error(`Не удалось запустить ${isCli ? 'CLI' : 'Electron'}: ${e.message}`);
  process.exit(1);
});
