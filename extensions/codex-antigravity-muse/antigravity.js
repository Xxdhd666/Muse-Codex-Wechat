'use strict';
/*
 * Antigravity 自动采集（坚决不手动填写）。
 * 实测可用的办法：直接以交互模式跑 agy、把 "/usage\n" 写进 stdin 管道，
 * agy 会把额度以 TSV 形式打到 stdout 后退出（agy --print /usage 不行，
 * 它会把 /usage 当成模型提问而超时）。应用主进程每 5 分钟这样跑一次，
 * 也可在托盘“刷新数据”时立即跑。
 * 本模块不读、不存、不输出任何授权文件或凭证，只解析百分比和重置时间。
 * 管道输出的百分比是整数（TUI 里是两位小数，如 Argon 99.91% 会显示为 100%），
 * 这是官方输出的取整，不是编造。
 * 关键：agy 必须事先在“运行本应用的那台电脑”上安装并登录过一次。
 * 云主机上的 agy 登录只在云主机上有效，Windows 上的应用不能用它，
 * 必须在 Windows 上再装一次 agy 并登录一次（同一 Google 账号即可）。
 * 找 agy 的办法：先试 PATH 里的 agy / agy.exe，再试 Windows / Linux /
 * macOS 的常见安装路径，再在 Windows 上跑 where agy；全部失败时返回
 * 诊断信息（试过的路径、最后的错误），不编一个百分比。
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function parseUsageTsv(text) {
  const pools = {};
  const defs = [
    { id: 'gemini', name: 'Gemini 组', keys: ['gemini models'] },
    { id: 'claude_gpt', name: 'Claude', keys: ['claude and gpt models'] },
    { id: 'argon', name: 'Gemini 4 Argon', keys: ['gemini 4 argon'] },
  ];
  for (const line of String(text || '').split(/\r?\n/)) {
    const parts = line.split('\t').map((s) => s.trim());
    if (parts.length < 3) continue;
    const poolName = parts[0].toLowerCase();
    const label = parts[1].toLowerCase();
    const pct = Number(parts[2].replace('%', ''));
    if (!Number.isFinite(pct)) continue;
    const def = defs.find((d) => d.keys.some((k) => poolName.includes(k)));
    if (!def) continue;
    if (!pools[def.id]) pools[def.id] = { id: def.id, name: def.name, status: 'auto', source: 'agy /usage 自动采集', as_of: new Date().toISOString(), weekly: null, five_hour: null };
    const entry = { remaining_pct: pct, resets_at: parts[3] || null, resets_approx: false };
    if (label.includes('weekly')) pools[def.id].weekly = entry;
    else if (label.includes('five hour')) pools[def.id].five_hour = entry;
  }
  return Object.values(pools).filter((p) => p.weekly || p.five_hour);
}

function candidatePaths() {
  const home = os.homedir();
  const out = ['agy', 'agy.exe'];
  const join = (...a) => path.join(...a);
  // Windows 常见路径（只保留实际存在的文件，避免在界面上列一堆不存在的路径）
  const winCandidates = [
    join(home, '.local', 'bin', 'agy.exe'),
    join(home, '.local', 'bin', 'agy'),
    // 官方 Windows PowerShell 安装器的默认位置（irm install.ps1）
    join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'agy', 'bin', 'agy.exe'),
    join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Programs', 'Antigravity', 'agy.exe'),
    join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'antigravity', 'agy.exe'),
    join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Antigravity', 'agy.exe'),
  ];
  const unixCandidates = [
    join(home, '.local', 'bin', 'agy'),
    '/usr/local/bin/agy',
    join(home, '.antigravity', 'bin', 'agy'),
  ];
  for (const p of (process.platform === 'win32' ? winCandidates : unixCandidates)) {
    try { if (fs.existsSync(p)) out.push(p); } catch (e) {}
  }
  // Windows：where agy 能找到 PATH 里但 spawn 直接叫不到的安装
  if (process.platform === 'win32') {
    try {
      const r = spawnSync('where', ['agy'], { encoding: 'utf8', timeout: 5000, shell: true });
      const first = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (first && !out.includes(first)) out.push(first);
    } catch (e) {}
  }
  return out;
}

function tryOne(cmd) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    let proc;
    try {
      // cwd 设为用户主目录：不要让 agy 把应用的解压目录当成工作区而弹信任提示
      proc = spawn(cmd, [], { stdio: ['pipe', 'pipe', 'pipe'], cwd: os.homedir(), shell: process.platform === 'win32' && (cmd.endsWith('.cmd') || cmd.endsWith('.bat')) });
    } catch (e) { return resolve({ ok: false, error: e.message }); }
    const finish = (result) => { if (done) return; done = true; try { proc.kill(); } catch (e) {} resolve(result); };
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => finish({ ok: false, error: e.message }));
    proc.on('close', () => {
      const pools = parseUsageTsv(out);
      if (pools.length) return finish({ ok: true, pools, cmd });
      const low = (out + err).toLowerCase();
      if (low.includes('not logged') || low.includes('not eligible') || low.includes('sign in')) {
        return finish({ ok: false, error: 'not_logged_in' });
      }
      return finish({ ok: false, error: (err.trim().split('\n')[0] || out.trim().split('\n')[0] || '无输出').slice(0, 200) });
    });
    try { proc.stdin.write('/usage\n'); proc.stdin.end(); } catch (e) {}
    setTimeout(() => finish({ ok: false, error: 'timeout' }), 30000);
  });
}

function hasLoginFile() {
  // 只查登录文件“是否存在”，不读内容、不读凭证。注意平台差异：
  // Linux 上凭证就是 ~/.gemini/antigravity-cli/antigravity-oauth-token 这个文件；
  // Windows 上凭证在 Windows 凭据管理器里（目标名 gemini:antigravity），
  // .gemini 里不一定有这个文件，macOS 上在钥匙串里——所以这个检查
  // 只在 Linux 上作“未登录”的判定依据，Windows/macOS 上绝不能用
  // “文件不存在”就判未登录，否则登录成功了也会永远报未登录（v5 的 bug）。
  if (process.platform !== 'linux') return true;
  const home = os.homedir();
  const candidates = [
    path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
    path.join(home, '.gemini', 'antigravity-cli', 'antigravity-accounts.json'),
  ];
  return candidates.some((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });
}

async function collectAntigravity() {
  if (!hasLoginFile()) {
    return { ok: false, reason: 'not_logged_in', tried: candidatePaths(), lastError: '未找到 agy 登录文件，请先在终端里手动跑一次 agy 完成登录', pools: [] };
  }
  const tried = candidatePaths();
  let lastError = '';
  for (const cmd of tried) {
    const r = await tryOne(cmd);
    if (r.ok) return { ok: true, method: 'pipe', agyPath: r.cmd, pools: r.pools };
    lastError = r.error || '';
    // 已找到 agy 但未登录：不用再试其他路径，直接报未登录
    if (lastError === 'not_logged_in') return { ok: false, reason: 'not_logged_in', agyPath: cmd, tried, lastError, pools: [] };
    // spawn 失败（ENOENT）继续试下一个路径；有输出但解析失败则不再换路径
    if (!/ENOENT|not found|找不到/i.test(lastError)) break;
  }
  return { ok: false, reason: 'no_agy', tried, lastError, pools: [] };
}

module.exports = { collectAntigravity, parseUsageTsv, candidatePaths, hasLoginFile };

// 独立运行测试：node antigravity.js --test （只输出解析到的百分比，不输出任何凭证）
if (require.main === module && process.argv.includes('--test')) {
  collectAntigravity().then((r) => {
    console.log(JSON.stringify({ ok: r.ok, reason: r.reason || null, agyPath: r.agyPath || null, tried: r.tried || null, pools: r.pools.map((p) => ({ id: p.id, weekly: p.weekly && p.weekly.remaining_pct, five_hour: p.five_hour && p.five_hour.remaining_pct })) }, null, 2));
  });
}
