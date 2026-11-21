'use strict';

/**
 * Electron-оболочка: окно, IPC-мост, жизненный цикл агента.
 *
 * Вся логика агента живёт в главном процессе (Node), рендерер — только UI.
 * Это принципиально: у рендерера нет доступа к файловой системе и процессам.
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, saveConfig } = require('../core/config');
const { Session } = require('../core/session');
const { McpManager } = require('../core/mcp');
const { Agent } = require('../core/agent');

// Режим скриншота: GPU-композитинг в удалённой сессии не отдаёт кадр
// (capturePage падает с UnknownVizError), поэтому рисуем программно.
if (process.env.D3M3NK0_SCREENSHOT) app.disableHardwareAcceleration();

let win = null;
let config = loadConfig();
let session = new Session();
let mcp = new McpManager();
let agent = null;
const pendingPermissions = new Map();

function emit(event) {
  if (win && !win.isDestroyed()) win.webContents.send('agent:event', event);
}

function askPermission(req) {
  return new Promise((resolve) => {
    pendingPermissions.set(req.id, resolve);
    if (win && !win.isDestroyed()) win.webContents.send('permission:request', req);
    else resolve(false);
  });
}

async function buildAgent({ history = [] } = {}) {
  agent?.abort();
  await mcp.closeAll();
  const report = await mcp.connectAll(config.mcpServers);
  for (const r of report) {
    if (!r.ok) {
      emit({ type: 'info', message: `MCP ${r.server}: ошибка — ${r.error}` });
      continue;
    }
    const kTokens = Math.ceil(r.chars / 4 / 1000);
    emit({
      type: 'info',
      message:
        `MCP ${r.server}: ${r.tools} из ${r.total} инструментов (~${kTokens}k токенов)` +
        (kTokens > 40 ? ' — много, ограничьте набор через "tools" в настройках' : ''),
    });
  }
  agent = new Agent({ config, session, mcp, emit, askPermission });
  agent.loadHistory(history);
  emit({ type: 'mcp_status', servers: mcp.status });
  return agent;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#12141a',
    title: 'd3m3nk0',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => {
    win = null;
  });
}

/** Выполнить fn, когда страница уже загружена (или сразу, если загрузка прошла). */
function onRendererReady(fn) {
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', fn);
  else fn();
}

app.whenReady().then(async () => {
  createWindow();

  // Обработчики регистрируются до buildAgent(): подключение MCP занимает
  // секунды, и окно успевает загрузиться раньше, теряя событие.
  const screenshotTo = process.env.D3M3NK0_SCREENSHOT;
  const smoke = !!process.env.D3M3NK0_SMOKE;

  if (screenshotTo) {
    // Снимок настоящего окна для документации: docs/screenshot.png.
    onRendererReady(async () => {
      const out = path.resolve(screenshotTo);
      let saved = false;

      // Необязательный сценарий: отправить запрос и дождаться ответа,
      // чтобы снимок показывал живой диалог, а не пустое окно.
      const prompt = process.env.D3M3NK0_SHOT_PROMPT;
      if (prompt) {
        try {
          // Идём через UI, а не через IPC: так работают и пузырь пользователя,
          // и блокировка ввода, по которой видно завершение хода.
          await win.webContents.executeJavaScript(
            `(() => {
               const input = document.getElementById('input');
               input.value = ${JSON.stringify(prompt)};
               document.getElementById('send').click();
               return true;
             })()`
          );
          for (let i = 0; i < 240; i++) {
            await new Promise((r) => setTimeout(r, 500));
            const busy = await win.webContents.executeJavaScript("document.getElementById('send').disabled");
            if (!busy) break;
          }
        } catch (e) {
          console.log('SCREENSHOT: сценарий не выполнен —', e.message);
        }
      }

      for (let attempt = 1; attempt <= 5 && !saved; attempt++) {
        try {
          await new Promise((r) => setTimeout(r, 600)); // дать UI дорисоваться
          const image = await win.webContents.capturePage();
          const size = image.getSize();
          if (!size.width || !size.height) throw new Error('пустой кадр');
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, image.toPNG());
          console.log('SCREENSHOT:', out, JSON.stringify(size));
          saved = true;
        } catch (e) {
          console.log(`SCREENSHOT: попытка ${attempt} не удалась — ${e.message}`);
        }
      }
      app.exit(saved ? 0 : 1);
    });
  }

  if (smoke) {
    // Самопроверка: приложение должно подняться и корректно закрыться.
    onRendererReady(async () => {
      console.log('SMOKE: renderer загружен');
      setTimeout(async () => {
        try {
          const badge = await win.webContents.executeJavaScript(
            "document.getElementById('model-badge').textContent"
          );
          console.log('SMOKE: model-badge =', badge);
        } catch (e) {
          console.log('SMOKE: ошибка проверки —', e.message);
        }
        app.quit();
      }, 1200);
    });
    setTimeout(() => {
      console.log('SMOKE: жёсткий таймаут, выходим');
      app.quit();
    }, 8000);
  }

  await buildAgent();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  try {
    await mcp.closeAll();
  } catch {
    // закрытие MCP не должно блокировать выход
  }
});

/* ---------------------------------- IPC ---------------------------------- */

ipcMain.handle('config:get', () => ({
  ...config,
  apiKey: config.apiKey ? '••••••••' : '',
  hasKey: !!config.apiKey,
}));

ipcMain.handle('config:set', async (_e, patch) => {
  const clean = { ...patch };
  if (!clean.apiKey || clean.apiKey.startsWith('••')) delete clean.apiKey;
  config = saveConfig(clean);
  await buildAgent({ history: agent?.history || [] });
  return { ok: true, workdir: config.workdir, model: config.model, provider: config.provider };
});

ipcMain.handle('session:list', () => Session.list());

ipcMain.handle('session:new', async () => {
  session = new Session();
  await buildAgent({ history: [] });
  return { id: session.id };
});

ipcMain.handle('session:load', async (_e, id) => {
  const loaded = Session.load(id);
  session = new Session(id);
  await buildAgent({ history: loaded.messages });
  return { id, messages: loaded.messages };
});

ipcMain.handle('agent:send', async (_e, text) => {
  if (!agent) await buildAgent();
  agent.send(text).catch((e) => emit({ type: 'error', message: String(e.message || e) }));
  return { ok: true };
});

ipcMain.handle('agent:abort', () => {
  agent?.abort();
  return { ok: true };
});

ipcMain.handle('mcp:status', () => mcp.status);

ipcMain.on('permission:reply', (_e, { id, approved }) => {
  const resolve = pendingPermissions.get(id);
  if (resolve) {
    pendingPermissions.delete(id);
    resolve(!!approved);
  }
});
