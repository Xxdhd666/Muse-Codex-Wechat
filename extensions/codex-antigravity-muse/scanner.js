'use strict';
/*
 * 本地扫描 Codex rollout 文件。只读 <codex>/sessions 下的 rollout-*.jsonl，
 * 不读 auth.json 等任何授权文件，不联网。可单独运行：node scanner.js [sessionsDir]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function defaultSessionsDir() {
  const home = process.env.CODEX_HOME || path.join(process.env.USERPROFILE || os.homedir(), '.codex');
  return path.join(home, 'sessions');
}

function findRollouts(root) {
  const out = [];
  (function walk(dir, depth) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (depth < 6) walk(p, depth + 1); }
      else if (ent.isFile() && /^rollout-.*\.jsonl$/.test(ent.name)) out.push(p);
    }
  })(root, 0);
  // 文件名含时间戳，按文件名排序即按时间排序
  return out.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

function parseRollout(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { model: null, events: [] }; }
  let model = null;
  const events = [];
  for (const line of text.split('\n')) {
    if (!model && line.includes('"turn_context"')) {
      try { const m = (JSON.parse(line).payload || {}).model; if (m) model = m; } catch (e) { /* 忽略坏行 */ }
    }
    if (!line.includes('"token_count"')) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (e) { continue; }
    const p = obj.payload || {};
    if (p.type === 'token_count') events.push({ ts: obj.timestamp, p });
  }
  return { model, events };
}

const epochIso = (sec) => (sec == null ? null : new Date(Number(sec) * 1000).toISOString());
const pctLeft = (w) => (!w || w.used_percent == null ? null : Math.round((100 - Number(w.used_percent)) * 100) / 100);
const noData = { id: 'codex', name: 'Codex Plus', status: 'no_data' };

function codexPool(files) {
  for (let i = files.length - 1; i >= 0; i--) {
    const { events } = parseRollout(files[i]);
    for (let j = events.length - 1; j >= 0; j--) {
      const rl = events[j].p.rate_limits;
      if (!rl || !rl.primary) continue;
      const pri = rl.primary, sec = rl.secondary;
      return {
        id: 'codex', name: 'Codex Plus', status: 'ok', source: '本机 Codex rollout 文件', as_of: events[j].ts,
        weekly: sec ? { remaining_pct: pctLeft(sec), resets_at: epochIso(sec.resets_at) } : null,
        five_hour: { remaining_pct: pctLeft(pri), resets_at: epochIso(pri.resets_at) },
      };
    }
  }
  return noData;
}

function usageRows(files, limit) {
  const rows = [];
  for (let i = files.length - 1; i >= 0 && rows.length < limit; i--) {
    const { model, events } = parseRollout(files[i]);
    if (!events.length) continue;
    const last = events[events.length - 1];
    const tot = (last.p.info || {}).total_token_usage;
    if (!tot) continue;
    const rls = events.map((e) => e.p.rate_limits).filter(Boolean);
    let change = null, basis = null;
    if (rls.length) {
      for (const [key, label] of [['secondary', '周'], ['primary', '5小时']]) {
        const a = (rls[0][key] || {}).used_percent, b = (rls[rls.length - 1][key] || {}).used_percent;
        if (a != null && b != null) { change = Math.round(-(b - a) * 100) / 100; basis = label; break; }
      }
    }
    rows.push({
      time: last.ts, pool_id: 'codex', pool: 'Codex Plus', model: model || '未记录',
      input_tokens: tot.input_tokens, output_tokens: tot.output_tokens, total_tokens: tot.total_tokens,
      pct_change: change, pct_basis: basis, session: path.basename(files[i]), source: 'codex-local',
    });
  }
  return rows;
}

function scan(root, limit) {
  root = root || defaultSessionsDir();
  limit = limit || 10;
  let files = [];
  try { if (fs.statSync(root).isDirectory()) files = findRollouts(root); } catch (e) { /* 目录不存在 */ }
  return { root, files: files.length, codex: codexPool(files), usage: usageRows(files, limit) };
}

module.exports = { scan, defaultSessionsDir };

if (require.main === module) {
  const r = scan(process.argv[2]);
  console.log(JSON.stringify({ root: r.root, files: r.files, codex: r.codex, usageRows: r.usage.length }, null, 2));
}
