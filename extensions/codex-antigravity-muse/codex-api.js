'use strict';
/*
 * Codex 后端接口直查（v11，不用下载、不装 CLI、不跑模型）。
 *
 * 桌面版 Codex 登录后，本机 %USERPROFILE%\.codex\auth.json 里已有登录
 * token，直接问 ChatGPT 后端就能拿到实时额度，不需要再装一个 codex 命令。
 *   GET https://chatgpt.com/backend-api/wham/usage
 *   Authorization: Bearer <本地 token>，ChatGPT-Account-Id: <本地 account_id>
 * 返回 rate_limit.primary_window / secondary_window 的 used_percent 与 reset_at。
 * 安全边界：token 只在内存里读一次、只发给 chatgpt.com，绝不写日志、
 * 不写文件、不进任何诊断文本、不发给任何第三方；失败时只返回状态码，
 * 不带 token。
 * secondary used 37%，与 app-server 的周 65% 方向一致（5 小时数随使用变化）。
 * 若 token 过期（401），本模块直接失败，主进程回落到本地会话，不自动刷新。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

function collectCodexApi() {
  return new Promise((resolve) => {
    let authPath;
    try {
      const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
      authPath = path.join(home, 'auth.json');
      const raw = fs.readFileSync(authPath, 'utf8');
      const d = JSON.parse(raw);
      const tok = d && d.tokens && d.tokens.access_token;
      const acct = d && d.tokens && d.tokens.account_id;
      if (!tok) return resolve({ ok: false, lastError: 'auth.json 里没有 access_token' });
      const req = https.request({
        hostname: 'chatgpt.com', path: '/backend-api/wham/usage', method: 'GET',
        headers: { 'Authorization': 'Bearer ' + tok, 'ChatGPT-Account-Id': acct || '', 'Accept': 'application/json', 'User-Agent': 'QuotaFloat/1.0' },
        timeout: 15000,
      }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve({ ok: false, lastError: 'wham/usage status ' + res.statusCode });
          try {
            const j = JSON.parse(body);
            const rl = j.rate_limit || {};
            const epochIso = (s) => (s == null ? null : new Date(Number(s) * 1000).toISOString());
            const pool = {
              id: 'codex', name: 'Codex Plus', status: 'ok', source: 'ChatGPT 后端接口（本地登录）',
              as_of: new Date().toISOString(),
              five_hour: rl.primary_window ? { remaining_pct: Math.round((100 - Number(rl.primary_window.used_percent)) * 100) / 100, resets_at: epochIso(rl.primary_window.reset_at) } : null,
              weekly: rl.secondary_window ? { remaining_pct: Math.round((100 - Number(rl.secondary_window.used_percent)) * 100) / 100, resets_at: epochIso(rl.secondary_window.reset_at) } : null,
              plan_type: j.plan_type || null,
            };
            resolve({ ok: true, pool });
          } catch (e) { resolve({ ok: false, lastError: 'wham 返回解析失败' }); }
        });
      });
      req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve({ ok: false, lastError: 'wham timeout' }); });
      req.on('error', (e) => resolve({ ok: false, lastError: e.message }));
      req.end();
    } catch (e) { resolve({ ok: false, lastError: '读 auth.json 失败：' + (e.code || e.message) }); }
  });
}

module.exports = { collectCodexApi };
