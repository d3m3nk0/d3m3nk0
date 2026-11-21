'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('d3', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  listSessions: () => ipcRenderer.invoke('session:list'),
  newSession: () => ipcRenderer.invoke('session:new'),
  loadSession: (id) => ipcRenderer.invoke('session:load', id),
  send: (text) => ipcRenderer.invoke('agent:send', text),
  abort: () => ipcRenderer.invoke('agent:abort'),
  mcpStatus: () => ipcRenderer.invoke('mcp:status'),
  replyPermission: (id, approved) => ipcRenderer.send('permission:reply', { id, approved }),
  onEvent: (cb) => ipcRenderer.on('agent:event', (_e, ev) => cb(ev)),
  onPermission: (cb) => ipcRenderer.on('permission:request', (_e, req) => cb(req)),
});
