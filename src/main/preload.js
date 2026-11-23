'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('d3', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  listSessions: () => ipcRenderer.invoke('session:list'),
  newSession: () => ipcRenderer.invoke('session:new'),
  loadSession: (id) => ipcRenderer.invoke('session:load', id),
  sessionMenu: (id, pinned) => ipcRenderer.invoke('session:menu', { id, pinned }),
  renameSession: (id, name) => ipcRenderer.invoke('session:rename', { id, name }),
  // Профили провайдеров: ключ уходит в главный процесс и обратно в окно не возвращается.
  saveProfile: (profile) => ipcRenderer.invoke('profiles:save', profile),
  deleteProfile: (id) => ipcRenderer.invoke('profiles:delete', id),
  activateProfile: (id) => ipcRenderer.invoke('profiles:activate', id),
  modelMenu: () => ipcRenderer.invoke('model:menu'),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  appInfo: () => ipcRenderer.invoke('app:info'),
  usage: () => ipcRenderer.invoke('usage:get'),
  openPlace: (place) => ipcRenderer.invoke('shell:openPlace', place),
  attachBytes: (name, data) => ipcRenderer.invoke('attach:bytes', { name, data }),
  attachFile: (src) => ipcRenderer.invoke('attach:file', src),
  // Путь перетащенного файла (в Electron 32+ File.path больше нет).
  pathForFile: (file) => webUtils.getPathForFile(file),
  send: (text) => ipcRenderer.invoke('agent:send', text),
  abort: () => ipcRenderer.invoke('agent:abort'),
  mcpStatus: () => ipcRenderer.invoke('mcp:status'),
  plugins: () => ipcRenderer.invoke('mcp:plugins'),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),
  replyPermission: (id, approved, always = false) => ipcRenderer.send('permission:reply', { id, approved, always }),
  onEvent: (cb) => ipcRenderer.on('agent:event', (_e, ev) => cb(ev)),
  onPermission: (cb) => ipcRenderer.on('permission:request', (_e, req) => cb(req)),
});
