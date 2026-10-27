'use strict';
/*
 * Codex 实时额度查询 v12 —— 按用户自己的 CodexOrb 实现原样改写。
 *
 * 与 Quota.cs），指出之前版本仍读不到。之前版本的问题：
 *  - 只发 initialize 就直接发 rateLimits，没发 initialized 通知，也没先
 *    发 account/read；
 *  - 在 Windows 上没用 --listen stdio://，子进程可能不用 stdio 通信。
 * 正确流程（CodexOrb 同款，悬浮球不直接读登录凭据文件，凭据由 Codex
 * 自己读取和使用，悬浮球只收 JSON）：
 *   codex.exe app-server --listen stdio://
 *   {"id":1,"method":"initialize","params":{"clientInfo":{"name":"codex_orb","title":"Codex Orb","version":"1.0.0"}}}
 *   {"method":"initialized"}
 *   {"id":2,"method":"account/read","params":{"refreshToken":false}}
 *   {"id":3,"method":"account/rateLimits/read","params":{}}
 * 解析：优先 result.rateLimitsByLimitId.codex.primary/secondary，兼容旧版
 * result.rateLimits.primary/secondary；剩余 = 100 - usedPercent；
 * resetsAt 为 Unix 秒。超时 22 秒（CodexOrb 同款），查完关闭子进程。
 *
 * secondary used 38%（剩余 62%），与后端接口方向一致。
 * 另：后端接口 GET https://chatgpt.com/backend-api/wham/usage 仍作为
 * app-server 全失败时的备用（见 codex-api.js），不走它时不读 auth.json。
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function candidateCodexPaths() {
  const home = os.homedir();
  const out = ['codex', 'codex.exe'];
  const join = (...a) => path.join(...a);
  const cands = process.platform === 'win32' ? [
    join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
    join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin', 'codex.exe'),
    join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'npm', 'codex.cmd'),
    join(home, '.local', 'bin', 'codex.exe'),
  ] : [
    join(home, '.local', 'bin', 'codex'),
    '/usr/local/bin/codex',
  ];
  for (const p of cands) {
    try { if (fs.existsSync(p)) out.push(p); } catch (e) {}
  }
  if (process.platform === 'win32') {
    try {
      const r = spawnSync('where', ['codex'], { encoding: 'utf8', timeout: 5000, shell: true });
      const first = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (first && !out.includes(first)) out.push(first);
    } catch (e) {}
    try {
      const r = spawnSync('powershell', ['-NoProfile', '-Command', '(Get-AppxPackage OpenAI.Codex).InstallLocation'], { encoding: 'utf8', timeout: 8000 });
      const loc = (r.stdout || '').trim();
      if (loc) {
        const p = path.join(loc, 'app', 'resources', 'codex.exe');
        if (fs.existsSync(p) && !out.includes(p)) out.push(p);
      }
    } catch (e) {}
  }
  return [...new Set(out)];
}

function tryOne(cmd, args) {
  return new Promise((resolve) => {
    let buf = '', done = false, sentRate = false;
    let proc;
    try { proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: os.homedir(), shell: /\.cmd$/i.test(cmd) }); }
    catch (e) { return resolve({ ok: false, error: e.message }); }
    const finish = (result) => { if (done) return; done = true; try { proc.stdin.end(); } catch (e) {} try { proc.kill(); } catch (e) {} try { proc.stdout.destroy(); } catch (e) {} try { proc.stderr.destroy(); } catch (e) {} resolve(result); };
    const send = (m) => { try { proc.stdin.write(JSON.stringify(m) + '\n'); } catch (e) {} };
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        let o; try { o = JSON.parse(line); } catch (e) { continue; }
        if (!o) continue;
        if (o.id === 1 && o.result) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/read', params: { refreshToken: false } });
        } else if (o.id === 2 && o.result && !sentRate) {
          sentRate = true;
          send({ id: 3, method: 'account/rateLimits/read', params: {} });
        } else if (o.id === 3 && o.result) {
          const r = o.result;
          const rl = (r.rateLimitsByLimitId && r.rateLimitsByLimitId.codex) || r.rateLimits;
          if (!rl) return finish({ ok: false, error: 'rateLimits 字段缺失' });
          const epochIso = (s) => (s == null ? null : new Date(Number(s) * 1000).toISOString());
          const pool = {
            id: 'codex', name: 'Codex Plus', status: 'ok', source: 'codex app-server 实时查询',
            as_of: new Date().toISOString(),
            five_hour: rl.primary ? { remaining_pct: Math.round((100 - Number(rl.primary.usedPercent)) * 100) / 100, resets_at: epochIso(rl.primary.resetsAt) } : null,
            weekly: rl.secondary ? { remaining_pct: Math.round((100 - Number(rl.secondary.usedPercent)) * 100) / 100, resets_at: epochIso(rl.secondary.resetsAt) } : null,
            plan_type: rl.planType || (r.rateLimits && r.rateLimits.planType) || null,
          };
          return finish({ ok: true, cmd, pool });
        } else if (o.id === 3 && o.error) {
          return finish({ ok: false, error: String(o.error.message || o.error) });
        }
      }
    });
    proc.stderr.on('data', () => {});
    proc.on('error', (e) => finish({ ok: false, error: e.message }));
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex_orb', title: 'Codex Orb', version: '1.0.0' } } });
    setTimeout(() => finish({ ok: false, error: 'timeout' }), 22000);
  });
}

async function collectCodexLive() {
  const tried = candidateCodexPaths();
  const errors = [];
  for (const cmd of tried) {
    for (const args of [['app-server', '--listen', 'stdio://'], ['app-server']]) {
      const r = await tryOne(cmd, args);
      if (r.ok) return { ok: true, cmd: r.cmd, args, pool: r.pool, diag: { tried, errors } };
      errors.push(cmd + ' ' + args.join(' ') + ': ' + (r.error || 'unknown'));
      if (/ENOENT|not found|找不到/i.test(r.error || '')) break;
    }
  }
  return { ok: false, tried, errors, lastError: errors[errors.length - 1] || '', pool: null, diag: { tried, errors } };
}

module.exports = { collectCodexLive, candidateCodexPaths };

if (require.main === module && process.argv.includes('--test')) {
  collectCodexLive().then((r) => {
    console.log(JSON.stringify({ ok: r.ok, cmd: r.cmd || null, args: r.args || null, lastError: r.lastError || null, pool: r.pool ? { five_hour: r.pool.five_hour, weekly: r.pool.weekly } : null }, null, 2));
    process.exit(0);
  });
}
