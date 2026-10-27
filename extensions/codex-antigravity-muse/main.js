'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { scan } = require('./scanner');
const { collectAntigravity } = require('./antigravity');
const { collectCodexLive } = require('./codex-live');
const { collectCodexApi } = require('./codex-api');

const SCAN_INTERVAL = 5 * 60 * 1000;
const FULL = 100;                 // 完整球窗口边长（球 84px + 阴影留白）
const INSET = 8;                  // 球离窗口边缘的留白
const STRIP_W = 74, STRIP_H = 58; // 收起态窄条窗口
const SNAP = 30;                  // 离左右边缘多近算贴边
const DASH_W = 620, DASH_H = 720;

const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8'));
let settings, lastScan = null, ballWin = null, dashWin = null, tray = null, quitting = false;
let dragStart = null;
const paths = {};

/* ---------- 设置与数据文件（应用数据目录） ---------- */
function loadSettings() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(paths.settings, 'utf8')); } catch (e) { /* 首次运行 */ }
  // autoPools：上一次自动采集到的 Antigravity 池快照（带 as_of），不是手动填入。
  // 首次运行 seed 为空，第一次自动采集成功后显示 Antigravity 池。
  const autoPools = Array.isArray(s.autoPools) && s.autoPools.length ? s.autoPools : seed.pools;
  return {
    theme: ['auto', 'light', 'dark'].includes(s.theme) ? s.theme : 'auto',
    ballPool: typeof s.ballPool === 'string' ? s.ballPool : 'codex',
    autostart: !!s.autostart,
    autoPools,
    antigravityStatus: s.antigravityStatus || 'pending',
    antigravityDiag: s.antigravityDiag || null,
    ball: s.ball && typeof s.ball === 'object' ? s.ball : { x: null, y: null, dock: null },
  };
}
function writeJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
const saveSettingsFile = () => writeJson(paths.settings, settings);

let liveCodex = null, liveCodexError = null, liveCodexDiag = null;
function buildData() {
  const codex = liveCodex || (lastScan && lastScan.codex) || { id: 'codex', name: 'Codex Plus', status: 'no_data' };
  const pools = [codex].concat(settings.autoPools || []);
  const usage = (lastScan && lastScan.usage) || [];
  usage.sort((a, b) => String(b.time).localeCompare(String(a.time)));
  return {
    pools, usage, generated_at: new Date().toISOString(),
    scan: lastScan ? { root: lastScan.root, files: lastScan.files } : null,
    antigravityStatus: settings.antigravityStatus,
    antigravityDiag: settings.antigravityDiag || null,
    codexSource: liveCodex ? 'live' : 'local',
    codexLiveError: liveCodexError,
    codexDiag: liveCodexDiag,
    notes: 'Codex 来自本机 rollout 文件；Antigravity 三个池由 agy /usage 自动采集（管道输出解析），官方不公开 token 数。',
  };
}
function broadcast(ch, payload) {
  [ballWin, dashWin].forEach((w) => { if (w && !w.isDestroyed()) w.webContents.send(ch, payload); });
}
async function runScan(isManual) {
  try { lastScan = scan(); } catch (e) { console.error('scan failed:', e.message); }
  // Codex 实时查询优先：app-server 不跑模型、不花额度，3 秒左右出结果。
  // 失败时（没装 codex、没登录、超时）回落到本地会话快照，并在界面标注来源。
  try {
    const live = await collectCodexLive();
    liveCodexDiag = { cmd: live.cmd || null, args: live.args || null, tried: live.diag ? live.diag.tried : null, errors: live.diag ? live.diag.errors : null };
    if (live.ok && live.pool) { liveCodex = live.pool; liveCodexError = null; }
    else {
      // v11：app-server 找不到 codex 命令时，不用下载 CLI，直接用本机已有
      // 的桌面版登录（.codex\auth.json）问 ChatGPT 后端接口，token 只发给
      // chatgpt.com，不写日志、不存文件。失败才回落本地会话。
      const api = await collectCodexApi();
      if (api.ok && api.pool) { liveCodex = api.pool; liveCodexError = null; liveCodexDiag = { cmd: 'wham/usage（后端接口）', args: [], tried: [], errors: [] }; }
      else { liveCodex = null; liveCodexError = 'app-server：' + (live.lastError || 'unknown') + '；后端接口：' + (api.lastError || 'unknown'); }
    }
  } catch (e) { liveCodex = null; liveCodexError = e.message; }
  // 未登录时自动定时扫描不再启动 agy：否则每 5 分钟弹一次浏览器登录页，
  // 而后台进程没地方粘贴授权码，登录永远完不成。只有用户手动点刷新时才再试一次。
  if (!isManual && settings.antigravityStatus === 'not_logged_in') {
    const data0 = buildData();
    try { writeJson(paths.data, data0); } catch (e) {}
    broadcast('data', data0);
    updateTray(data0);
    return data0;
  }
  try {
    const ag = await collectAntigravity();
    if (ag.ok && ag.pools.length) {
      settings.autoPools = ag.pools;
      settings.antigravityStatus = 'auto';
      settings.antigravityDiag = { at: new Date().toISOString(), agyPath: ag.agyPath || null, method: ag.method || 'pipe' };
    } else {
      settings.antigravityStatus = ag.reason || 'error';
      settings.antigravityDiag = { at: new Date().toISOString(), agyPath: ag.agyPath || null, reason: ag.reason || null, lastError: ag.lastError || null, tried: ag.tried || null };
    }
    saveSettingsFile();
  } catch (e) { console.error('antigravity collect failed:', e.message); settings.antigravityStatus = 'error'; }
  const data = buildData();
  try { writeJson(paths.data, data); } catch (e) { console.error('write data failed:', e.message); }
  broadcast('data', data);
  updateTray(data);
  return data;
}

/* ---------- 悬浮球窗口 ---------- */
function workAreaFor(b) { return screen.getDisplayMatching(b).workArea; }
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function ballMode() { return { mode: settings.ball.dock ? 'strip' : 'full', side: settings.ball.dock }; }
function pushBallMode() { if (ballWin && !ballWin.isDestroyed()) ballWin.webContents.send('ball-mode', ballMode()); }

function placeFull(x, y) {
  const wa = workAreaFor({ x, y, width: FULL, height: FULL });
  x = clamp(Math.round(x), wa.x - INSET, wa.x + wa.width - FULL + INSET);
  y = clamp(Math.round(y), wa.y - INSET, wa.y + wa.height - FULL + INSET);
  ballWin.setBounds({ x, y, width: FULL, height: FULL });
}
function dockStrip(side, centerY, wa) {
  const y = clamp(Math.round(centerY - STRIP_H / 2), wa.y, wa.y + wa.height - STRIP_H);
  const x = side === 'left' ? wa.x : wa.x + wa.width - STRIP_W;
  ballWin.setBounds({ x, y, width: STRIP_W, height: STRIP_H });
  settings.ball = { x, y, dock: side };
  saveSettingsFile(); pushBallMode();
}
function undock() {
  const b = ballWin.getBounds(), wa = workAreaFor(b);
  const cy = b.y + b.height / 2;
  const x = settings.ball.dock === 'left' ? wa.x + 40 - INSET : wa.x + wa.width - FULL - 40 + INSET;
  settings.ball = { x: 0, y: 0, dock: null };
  placeFull(x, cy - FULL / 2);
  const nb = ballWin.getBounds();
  settings.ball = { x: nb.x, y: nb.y, dock: null };
  saveSettingsFile(); pushBallMode();
}

function createBall() {
  const wa = screen.getPrimaryDisplay().workArea;
  const b = settings.ball;
  ballWin = new BrowserWindow({
    width: FULL, height: FULL, x: wa.x + wa.width - FULL - 24, y: wa.y + 120,
    frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, show: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  ballWin.setAlwaysOnTop(true, 'screen-saver');
  ballWin.loadFile(path.join(__dirname, 'renderer', 'ball.html'));
  ballWin.once('ready-to-show', () => {
    if (b.dock && typeof b.y === 'number') {
      const w2 = workAreaFor({ x: b.x, y: b.y, width: STRIP_W, height: STRIP_H });
      dockStrip(b.dock, b.y + STRIP_H / 2, w2);
    } else if (typeof b.x === 'number') {
      placeFull(b.x, b.y);
    }
    ballWin.show();
  });
}

ipcMain.on('ball:drag-start', () => { if (ballWin) dragStart = ballWin.getBounds(); });
ipcMain.on('ball:drag-move', (_e, dx, dy) => {
  if (!ballWin || !dragStart) return;
  const x = dragStart.x + dx, y = dragStart.y + dy;
  ballWin.setBounds({ x: Math.round(x), y: Math.round(y), width: dragStart.width, height: dragStart.height });
});
ipcMain.on('ball:drag-end', () => {
  if (!ballWin || !dragStart) return;
  const b = ballWin.getBounds(), wa = workAreaFor(b), wasStrip = !!settings.ball.dock;
  dragStart = null;
  const vis = wasStrip
    ? { l: b.x, r: b.x + b.width }
    : { l: b.x + INSET, r: b.x + b.width - INSET };
  const cy = b.y + b.height / 2;
  if (vis.l - wa.x <= SNAP) return dockStrip('left', cy, wa);
  if (wa.x + wa.width - vis.r <= SNAP) return dockStrip('right', cy, wa);
  if (wasStrip) { // 拖离边缘 → 在松手处恢复完整球
    placeFull(b.x + b.width / 2 - FULL / 2, cy - FULL / 2);
    const nb = ballWin.getBounds();
    settings.ball = { x: nb.x, y: nb.y, dock: null };
    saveSettingsFile(); pushBallMode();
    return;
  }
  settings.ball = { x: b.x, y: b.y, dock: null };
  saveSettingsFile();
});
ipcMain.on('ball:click', () => {
  if (settings.ball.dock) undock(); else showDashboard();
});
ipcMain.handle('ball:mode', () => ballMode());

/* ---------- 仪表盘窗口 ---------- */
function createDashboard() {
  dashWin = new BrowserWindow({
    width: DASH_W, height: DASH_H, useContentSize: true, show: false, title: '额度仪表盘',
    resizable: false, maximizable: false, fullscreenable: false, autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  dashWin.setMenu(null);
  dashWin.loadFile(path.join(__dirname, 'renderer', 'dashboard.html'));
  dashWin.on('close', (e) => { if (!quitting) { e.preventDefault(); dashWin.hide(); } });
}
function showDashboard() {
  if (!dashWin || dashWin.isDestroyed()) createDashboard();
  const wa = screen.getPrimaryDisplay().workArea;
  if (!dashWin.isVisible()) {
    const cb = dashWin.getContentBounds();
    dashWin.setPosition(Math.round(wa.x + (wa.width - cb.width) / 2), Math.max(wa.y, Math.round(wa.y + (wa.height - cb.height) / 2)));
  }
  dashWin.show(); dashWin.focus();
}
ipcMain.on('dash:hide', () => { if (dashWin) dashWin.hide(); });

/* ---------- 托盘 ---------- */
function updateTray(data) {
  if (!tray) return;
  const c = (data.pools || []).find((p) => p.id === 'codex');
  const f = c && c.five_hour && c.five_hour.remaining_pct, w = c && c.weekly && c.weekly.remaining_pct;
  tray.setToolTip('额度悬浮球' + (f != null ? ' · Codex 5h ' + f + '%' + (w != null ? ' / 周 ' + w + '%' : '') : ''));
}
function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 }));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示仪表盘', click: showDashboard },
    { label: '刷新数据', click: runScan },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showDashboard);
  tray.setToolTip('额度悬浮球');
}

/* ---------- IPC：数据与设置 ---------- */
ipcMain.handle('data:get', () => buildData());
ipcMain.handle('data:refresh', () => runScan(true));
ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:save', (_e, patch) => {
  patch = patch || {};
  if (['auto', 'light', 'dark'].includes(patch.theme)) settings.theme = patch.theme;
  if (typeof patch.ballPool === 'string') settings.ballPool = patch.ballPool;
  if (typeof patch.autostart === 'boolean') {
    settings.autostart = patch.autostart;
    try { app.setLoginItemSettings({ openAtLogin: patch.autostart }); } catch (e) { console.error(e.message); }
  }
  saveSettingsFile();
  broadcast('settings', settings);
  return settings;
});
/* ---------- 生命周期 ---------- */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showDashboard);
  app.whenReady().then(() => {
    paths.settings = path.join(app.getPath('userData'), 'settings.json');
    paths.data = path.join(app.getPath('userData'), 'quota-data.json');
    settings = loadSettings();
    saveSettingsFile();
    createBall();
    createDashboard();
    createTray();
    // 启动时至少试一次 agy：上次状态是 not_logged_in 时，自动定时扫描会跳过，
    // 但用户可能在这期间已经手动登录完了，重启后必须再试一次，否则永远卡在旧状态（v5 的 bug）。
    runScan(true);
    setInterval(runScan, SCAN_INTERVAL);
  });
  // 关闭窗口不退出：悬浮球和托盘继续在后台运行
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => { quitting = true; });
}
