'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (ch, cb) => { ipcRenderer.on(ch, (_e, v) => cb(v)); };

contextBridge.exposeInMainWorld('QF', {
  getData: () => ipcRenderer.invoke('data:get'),
  refresh: () => ipcRenderer.invoke('data:refresh'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  // 没有手动填入口：Antigravity 由主进程自动采集，刷新走 refresh()
  onData: (cb) => on('data', cb),
  onSettings: (cb) => on('settings', cb),
  onBallMode: (cb) => on('ball-mode', cb),
  getBallMode: () => ipcRenderer.invoke('ball:mode'),
  ball: {
    dragStart: () => ipcRenderer.send('ball:drag-start'),
    dragMove: (dx, dy) => ipcRenderer.send('ball:drag-move', dx, dy),
    dragEnd: () => ipcRenderer.send('ball:drag-end'),
    click: () => ipcRenderer.send('ball:click'),
  },
  hideDashboard: () => ipcRenderer.send('dash:hide'),
});
