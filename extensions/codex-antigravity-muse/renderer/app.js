(function () {
  'use strict';

  var QF = window.QF;
  var NO_TOKENS = '—';
  var PAGE_SIZE = 8;

  var data = null;
  var loadError = null;
  var prefs = { ballPool: 'codex', theme: 'auto', autostart: false };

  var $ = function (id) { return document.getElementById(id); };

  /* ---------- 偏好（保存在主进程的 settings.json） ---------- */
  var SHORT = { codex: 'Codex', gemini: 'Gemini', claude_gpt: 'Claude', argon: 'Argon' };
  function applyPrefs(p) {
    if (!p) return;
    prefs.ballPool = p.ballPool || 'codex';
    prefs.theme = p.theme || 'auto';
    prefs.autostart = !!p.autostart;
  }
  var toastEl = null, toastTimer = 0;
  function toast(msg, isErr) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'toast'; toastEl.setAttribute('role', 'status'); document.body.appendChild(toastEl); }
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = 'toast' + (isErr ? ' err' : ''); }, 1600);
  }
  function savePrefs(patch, okMsg) {
    QF.saveSettings(patch).then(function (p) {
      applyPrefs(p); applyTheme(); renderSelect(); renderSettings(); toast(okMsg || '已保存');
    }).catch(function () { toast('保存失败，请重试', true); });
  }
  var scan = { busy: false, done: false };

  /* ---------- 工具 ---------- */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pct2(v) { return v.toFixed(2) + '%'; }
  function signed(v) { return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2) + '%'; }
  function ballText(v) { return v >= 99.95 ? '100' : v.toFixed(1); }
  function color(v) { return v >= 50 ? '#28a745' : v >= 20 ? '#c77700' : '#d63a30'; }
  function tone(v) { return v >= 50 ? 'tone-ok' : v >= 20 ? 'tone-mid' : 'tone-low'; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmtTime(iso, withYear) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d)) return '—';
    return (withYear ? d.getFullYear() + '-' : '') + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function dayOf(iso) {
    var d = new Date(iso);
    return isNaN(d) ? null : d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function fmtInt(n) { return n == null ? '—' : Math.round(n).toLocaleString('en-US'); }
  function poolById(id) { return data && data.pools.filter(function (p) { return p.id === id; })[0]; }

  /* 某池的两个窗口（用于详情页：始终显示全部池） */
  function windowsOf(pool) {
    var out = [];
    if (pool.status === 'no_data') return out;
    if (pool.five_hour && pool.five_hour.remaining_pct != null) out.push({ label: '5 小时', w: pool.five_hour });
    if (pool.weekly && pool.weekly.remaining_pct != null) out.push({ label: '周', w: pool.weekly });
    return out;
  }
  function lowest(wins) {
    var m = null;
    wins.forEach(function (x) { if (m === null || x.w.remaining_pct < m.w.remaining_pct) m = x; });
    return m;
  }
  /* 5 小时为主、周为辅；没有 5 小时限额的池（Argon）只显示周 */
  function ballInfo(pool) {
    if (!pool || pool.status === 'no_data') return null;
    var f = pool.five_hour && pool.five_hour.remaining_pct != null ? pool.five_hour : null;
    var w = pool.weekly && pool.weekly.remaining_pct != null ? pool.weekly : null;
    if (f) return { main: f.remaining_pct, mainLabel: '5 小时', aux: w ? w.remaining_pct : null };
    if (w) return { main: w.remaining_pct, mainLabel: '周', aux: null, weeklyOnly: true };
    return null;
  }

  /* ---------- 详情页 ---------- */
  function renderDetail() {
    var el = $('view-detail');
    if (!data) { el.innerHTML = '<div class="empty">' + esc(loadError || '加载中…') + '</div>'; return; }
    var now = Date.now();
    el.innerHTML = '<div class="cards">' + data.pools.map(function (p) {
      var head = '<div class="card-name">' + esc(p.name) + '</div>';
      if (p.status === 'no_data') {
        return '<div class="card">' + head + '<div class="card-big nodata">暂无数据</div>' +
          '<div class="card-line"><span>周限额</span><span>—</span></div>' +
          '<div class="card-line"><span>5 小时限额</span><span>—</span></div>' +
          '<div class="card-reset">刷新：—</div></div>';
      }
      var m = lowest(windowsOf(p));
      var big = m ? '<div class="card-big num ' + tone(m.w.remaining_pct) + '">' +
        m.w.remaining_pct.toFixed(2) + '<span class="unit">%</span></div>'
        : '<div class="card-big nodata">—</div>';
      function line(label, w) {
        return '<div class="card-line"><span>' + label + '</span><span class="num">' +
          (w && w.remaining_pct != null ? pct2(w.remaining_pct) : '—') + '</span></div>';
      }
      var lines = line('周限额', p.weekly) + (p.five_hour ? line('5 小时限额', p.five_hour) : '');
      var reset = '刷新：—', cls = 'card-reset';
      if (m && m.w.resets_at) {
        reset = m.label + '刷新 ' + (m.w.resets_approx ? '约 ' : '') + fmtTime(m.w.resets_at);
        if (new Date(m.w.resets_at).getTime() < now) { reset = m.label + '已过刷新点，数据可能过期'; cls += ' stale'; }
      } else if (m) {
        reset = m.label + '刷新：未记录';
      }
      return '<div class="card">' + head + big + lines + '<div class="' + cls + '" title="' + esc(reset) + '">' + esc(reset) + '</div></div>';
    }).join('') + '</div>';
  }

  /* ---------- 悬浮球显示（选择页） ---------- */
  function renderSelect() {
    var el = $('view-select');
    if (!data) { el.innerHTML = ''; return; }
    var cur = poolById(prefs.ballPool) || data.pools[0];
    el.innerHTML =
      '<div class="group"><h3>悬浮球显示哪个额度池</h3>' +
      data.pools.map(function (p) {
        var b = ballInfo(p);
        var val = p.status === 'no_data' ? '暂无数据' : !b ? '—' :
          (b.aux != null ? '5h ' + b.main.toFixed(1) + ' · 周 ' + b.aux.toFixed(1) : '周 ' + b.main.toFixed(1));
        return '<label class="row"><input type="radio" name="ballpool" data-pool="' + esc(p.id) + '"' +
          (p.id === cur.id ? ' checked' : '') + '><span>' + esc(p.name) + '</span>' +
          '<span class="hint num">' + esc(val) + '</span></label>';
      }).join('') + '</div>' +
      '<p class="note">大号数字与外圈为 5 小时剩余，内圈与小字为周剩余；Argon 仅周。</p>';
  }

  /* ---------- 设置页 ---------- */
  var THEMES = [['auto', '跟随系统'], ['light', '浅色'], ['dark', '暗色']];
  function renderSettings() {
    if (!data) { $('view-settings').innerHTML = ''; return; }
    var ag = data.pools.filter(function (p) { return p.id !== 'codex'; });
    var agRows = ag.map(function (p) {
      var w = p.weekly && p.weekly.remaining_pct, f = p.five_hour && p.five_hour.remaining_pct;
      return '<div class="manual"><span>' + esc(p.name) + '</span><span class="num">' +
        (w != null ? '周 ' + w.toFixed(2) + '%' : '周 —') + '</span><span class="num">' +
        (f != null ? '5 小时 ' + f.toFixed(2) + '%' : '无 5 小时') + '</span>' +
        '<span class="asof">采集于 ' + fmtTime(p.as_of, true) + '</span></div>';
    }).join('');
    var diag = data.antigravityDiag || {};
    var agNote = data.antigravityStatus === 'auto' ? '来源：agy /usage 自动采集' :
      '采集失败' + (diag.lastError ? '：' + diag.lastError : (data.antigravityStatus === 'not_logged_in' ? '：agy 未登录' : '：未检测到 agy')) + '（显示上次快照）';
    var cx = data.pools.filter(function (p) { return p.id === 'codex'; })[0];
    var cxNote = data.codexSource === 'live'
      ? '来源：实时查询 · ' + fmtTime(cx && cx.as_of, true)
      : '实时查询失败，显示本地最后会话（' + fmtTime(cx && cx.as_of, true) + '）' + (data.codexLiveError ? '：' + data.codexLiveError : '');
    $('view-settings').innerHTML =
      '<div class="group"><h3>Codex 额度</h3>' +
      '<p class="setting-note">' + esc(cxNote) + '</p></div>' +
      '<div class="group"><h3>外观</h3><div class="seg">' + THEMES.map(function (t) {
        return '<button type="button" data-theme="' + t[0] + '" class="' + (prefs.theme === t[0] ? 'active' : '') + '">' + t[1] + '</button>';
      }).join('') + '</div></div>' +
      '<div class="group"><h3>后台运行</h3><label class="switch-row"><span>开机自启</span>' +
      '<input type="checkbox" id="autostart"' + (prefs.autostart ? ' checked' : '') + '></label>' +
      '</div>' +
      '<div class="group"><h3>Antigravity 额度</h3>' +
      '<div class="manual head"><span>额度池</span><span>周剩余</span><span>5 小时剩余</span><span></span></div>' + agRows +
      '<p class="setting-note">' + esc(agNote) + '</p></div>';
  }
  function applyTheme() {
    var dark = prefs.theme === 'dark' ||
      (prefs.theme === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  }

  /* ---------- 仪表盘 ---------- */
  var METRICS = [['total', '合计 token'], ['input', '输入 token'], ['output', '输出 token'], ['pct', '百分比变化']];
  var dash = { pool: 'all', model: 'all', day: 'all', metric: 'total', view: 'overview', page: 0 };
  var PALETTE = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c5)', 'var(--c4)', 'var(--c6)'];

  function hasTokens(r) { return r.total_tokens != null; }
  function val(r, m) {
    return m === 'input' ? r.input_tokens : m === 'output' ? r.output_tokens : m === 'total' ? r.total_tokens : r.pct_change;
  }
  function uniq(arr) {
    var seen = {}, out = [];
    arr.forEach(function (x) { if (x != null && !seen[x]) { seen[x] = 1; out.push(x); } });
    return out;
  }
  function sel(id, label, opts, cur) {
    return '<label class="f"><span>' + label + '</span><select id="' + id + '">' + opts.map(function (o) {
      return '<option value="' + esc(o[0]) + '"' + (o[0] === cur ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
    }).join('') + '</select></label>';
  }
  function group(rows, keyFn, m) {
    var map = {}, order = [];
    rows.forEach(function (r) {
      var v = val(r, m);
      if (v == null) return;
      var k = keyFn(r);
      if (k == null) return;
      if (!(k in map)) { map[k] = 0; order.push(k); }
      map[k] += v;
    });
    return order.map(function (k) { return { k: k, v: map[k] }; });
  }
  function short(n) {
    n = Math.abs(n);
    return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n));
  }
  function fmtVal(v, m) { return m === 'pct' ? signed(v) : fmtInt(v); }

  /* 环形图：按占比；纯 SVG（圆周长归一为 100） */
  function donut(items, m, title) {
    var total = items.reduce(function (a, x) { return a + Math.abs(x.v); }, 0);
    if (!items.length || total <= 0) {
      return '<div class="chart"><h4>' + title + '</h4><div class="bar-empty">' +
        (items.length ? '所选范围内该指标均为 0，无占比可画' : '该指标下暂无记录') + '</div></div>';
    }
    var off = 0, segs = '', legend = '';
    items.forEach(function (x, i) {
      var share = Math.abs(x.v) / total * 100, c = PALETTE[i % PALETTE.length];
      segs += '<circle cx="21" cy="21" r="15.9155" stroke="' + c + '" stroke-dasharray="' + share.toFixed(3) + ' ' + (100 - share).toFixed(3) +
        '" stroke-dashoffset="' + (-off).toFixed(3) + '"></circle>';
      off += share;
      legend += '<div class="lg-row"><span class="lg-dot" style="background:' + c + '"></span><span class="lg-k" title="' + esc(x.k) + '">' + esc(x.k) +
        '</span><span class="lg-v num">' + fmtVal(x.v, m) + '</span><span class="lg-p num">' + share.toFixed(1) + '%</span></div>';
    });
    return '<div class="chart"><h4>' + title + '</h4><div class="donut-wrap"><svg class="donut" viewBox="0 0 42 42" role="img" aria-label="' + esc(title) + '">' +
      '<circle class="track" cx="21" cy="21" r="15.9155"></circle>' + segs + '</svg><div class="legend">' + legend + '</div></div></div>';
  }

  /* 柱状图：items = [{k, v}] 或堆叠 [{k, a, b}] */
  function columns(title, sub, items, m, stacked) {
    var max = 0;
    items.forEach(function (x) { max = Math.max(max, stacked ? x.a + x.b : Math.abs(x.v)); });
    if (!items.length) return '<div class="chart"><h4>' + title + '</h4><div class="bar-empty">该指标下暂无记录</div></div>';
    var cols = items.map(function (x) {
      var tot = stacked ? x.a + x.b : x.v;
      var h = max > 0 ? Math.abs(tot) / max * 100 : 0;
      var inner = stacked
        ? '<span class="seg-in" style="height:' + (tot > 0 ? x.a / tot * 100 : 0).toFixed(1) + '%"></span><span class="seg-out" style="height:' + (tot > 0 ? x.b / tot * 100 : 0).toFixed(1) + '%"></span>'
        : '';
      return '<div class="col" title="' + esc(x.k + '：' + (stacked ? '输入 ' + fmtInt(x.a) + ' / 输出 ' + fmtInt(x.b) : fmtVal(x.v, m))) + '">' +
        '<span class="col-val num">' + (m === 'pct' ? signed(tot) : short(tot)) + '</span>' +
        '<span class="col-bar' + (m === 'pct' ? ' neg' : '') + '" style="height:calc(' + h.toFixed(1) + '% - 16px);">' + inner + '</span></div>';
    }).join('');
    var xs = items.map(function (x) { return '<span>' + esc(x.k) + '</span>'; }).join('');
    return '<div class="chart"><h4>' + title + '</h4>' + (sub ? '<div class="chart-sub">' + sub + '</div>' : '') +
      '<div class="cols">' + cols + '</div><div class="col-x">' + xs + '</div>' +
      (stacked ? '<div class="key"><span><i style="background:var(--c1)"></i>输入</span><span><i style="background:var(--c2)"></i>输出</span></div>' : '') + '</div>';
  }

  function renderUsage() {
    var el = $('view-usage');
    if (!data) { el.innerHTML = ''; return; }
    var all = data.usage || [];
    var models = uniq(all.map(function (r) { return r.model; }).filter(function (x) { return x && x !== '—'; })).sort();
    var days = uniq(all.map(function (r) { return dayOf(r.time); })).sort().reverse();
    if (dash.model !== 'all' && models.indexOf(dash.model) < 0) dash.model = 'all';
    if (dash.day !== 'all' && days.indexOf(dash.day) < 0) dash.day = 'all';

    var rows = all.filter(function (r) {
      return (dash.pool === 'all' || r.pool_id === dash.pool) &&
        (dash.model === 'all' || r.model === dash.model) &&
        (dash.day === 'all' || dayOf(r.time) === dash.day);
    });

    var html = '<div class="filters">' +
      sel('f-pool', '额度池', [['all', '全部']].concat(data.pools.map(function (p) { return [p.id, p.name]; })), dash.pool) +
      sel('f-model', '模型', [['all', '全部模型']].concat(models.map(function (x) { return [x, x]; })), dash.model) +
      sel('f-day', '日期', [['all', '全部日期']].concat(days.map(function (x) { return [x, x]; })), dash.day) +
      sel('f-metric', '指标', METRICS, dash.metric) + '</div>' +
      '<div class="subtabs"><div class="seg">' +
      [['overview', '概览'], ['table', '明细']].map(function (v) {
        return '<button type="button" data-view="' + v[0] + '" class="' + (dash.view === v[0] ? 'active' : '') + '">' + v[1] + '</button>';
      }).join('') + '</div></div>';

    if (!rows.length) {
      el.innerHTML = html + '<div class="empty">该组合下暂无记录</div>';
      return;
    }

    if (dash.view === 'table') {
      var pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
      if (dash.page >= pages) dash.page = pages - 1;
      var slice = rows.slice(dash.page * PAGE_SIZE, dash.page * PAGE_SIZE + PAGE_SIZE);
      html += '<div class="table-wrap"><table><thead><tr>' +
        '<th class="col-time">日期时间</th><th class="col-pool">额度池</th><th class="col-model">模型</th>' +
        '<th class="col-in r">输入 token</th><th class="col-out r">输出 token</th><th class="col-tot r">合计 token</th>' +
        '<th class="col-pct r">消耗百分比变化</th></tr></thead><tbody>' +
        slice.map(function (r) {
          var cells = !hasTokens(r)
            ? '<td colspan="3" class="plain">' + esc(r.tokens_note || NO_TOKENS) + '</td>'
            : '<td class="r">' + fmtInt(r.input_tokens) + '</td><td class="r">' + fmtInt(r.output_tokens) +
              '</td><td class="r">' + fmtInt(r.total_tokens) + '</td>';
          var pc = r.pct_change == null ? '—' : signed(r.pct_change) + (r.pct_basis ? ' <span class="basis">' + esc(r.pct_basis) + '</span>' : '');
          return '<tr><td title="' + esc(r.time) + '">' + fmtTime(r.time, true) + '</td><td>' + esc(r.pool) + '</td><td title="' +
            esc(r.model) + '">' + esc(r.model) + '</td>' + cells + '<td class="r">' + pc + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        '<div class="pager"><span>共 ' + rows.length + ' 条</span><span>' +
        '<button type="button" class="btn" data-page="-1"' + (dash.page <= 0 ? ' disabled' : '') + '>上一页</button> ' +
        '<span class="num">' + (dash.page + 1) + ' / ' + pages + '</span> ' +
        '<button type="button" class="btn" data-page="1"' + (dash.page >= pages - 1 ? ' disabled' : '') + '>下一页</button></span></div>';
      el.innerHTML = html;
      return;
    }

    var tokRows = rows.filter(hasTokens);
    var sum = function (f) { return tokRows.reduce(function (a, r) { return a + (r[f] || 0); }, 0); };
    var n = tokRows.length;
    function card(label, v) {
      return '<div class="stat"><div class="stat-k">' + label + '</div><div class="stat-v num">' + v + '</div></div>';
    }
    if (n) {
      var tot = sum('total_tokens');
      var maxS = Math.max.apply(null, tokRows.map(function (r) { return r.total_tokens || 0; }));
      html += '<div class="stats">' + card('合计 token', short(tot)) + card('输入 token', short(sum('input_tokens'))) +
        card('输出 token', short(sum('output_tokens'))) + card('会话数', fmtInt(n)) + '</div>' +
        '<div class="stat-sub"><span>平均每会话 <b class="num">' + fmtInt(tot / n) + '</b></span>' +
        '<span>最大单会话 <b class="num">' + fmtInt(maxS) + '</b></span></div>';
    } else {
      html += '<div class="stats">' + card('合计 token', '—') + card('输入 token', '—') + card('输出 token', '—') + card('会话数', '—') + '</div>' +
        '<div class="stat-sub"><span>所选范围内没有带 token 数的记录</span></div>';
    }

    var m = dash.metric, useRows = m === 'pct' ? rows : tokRows;
    var mLabel = METRICS.filter(function (x) { return x[0] === m; })[0][1];
    var byModel = group(useRows, function (r) { return r.model && r.model !== '—' ? r.model : (m === 'pct' ? '（无模型）' : null); }, m)
      .sort(function (a, b) { return Math.abs(b.v) - Math.abs(a.v); }).slice(0, 4);
    var byDay = group(useRows, function (r) { return dayOf(r.time); }, m).sort(function (a, b) { return a.k < b.k ? -1 : 1; })
      .slice(-7).map(function (x) { return { k: x.k.slice(5), v: x.v }; });
    html += '<div class="viz">' + donut(byModel, m, '模型占比 · ' + mLabel) + columns('每日 · ' + mLabel + '（最近 7 天）', '', byDay, m, false);
    if (m !== 'pct' && tokRows.length) {
      var ses = tokRows.slice().sort(function (a, b) { return a.time < b.time ? -1 : 1; }).slice(-10).map(function (r) {
        return { k: fmtTime(r.time).slice(0, 5), a: r.input_tokens || 0, b: r.output_tokens || 0 };
      });
      html += columns('最近会话的输入 / 输出 token', '', ses, m, true).replace('class="chart"', 'class="chart wide"');
    }
    html += '</div>';
    el.innerHTML = html;
  }

  function renderFoot() {
    var f = $('panel-foot');
    if (!data) { f.textContent = loadError ? '数据未加载' : ''; return; }
    var codex = data.pools.filter(function (p) { return p.id === 'codex' && p.status === 'ok'; })[0];
    var parts = [];
    parts.push(codex ? (data.codexSource === 'live' ? 'Codex 实时 ' : 'Codex 本地 ') + fmtTime(codex.as_of, true) : 'Codex：暂无数据');
    var man = data.pools.filter(function (p) { return p.status === 'auto'; })[0];
    if (man) parts.push('Antigravity ' + fmtTime(man.as_of, true));
    if (data.generated_at) parts.push('上次刷新 ' + fmtTime(data.generated_at, true));
    f.textContent = parts.join(' · ');
  }

  function renderAll() { renderDetail(); renderSelect(); renderUsage(); renderSettings(); renderFoot(); }

  /* ---------- 标签页 ---------- */
  var activeTab = 'detail';
  function setTab(t) {
    activeTab = t;
    document.querySelectorAll('.tab').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === t); });
    ['detail', 'select', 'usage', 'settings'].forEach(function (k) {
      var v = $('view-' + k), show = (k === t);
      if (show && v.hidden) { v.hidden = false; v.classList.remove('enter'); void v.offsetWidth; v.classList.add('enter'); }
      else if (!show) { v.hidden = true; v.classList.remove('enter'); }
    });
    $('open-settings').classList.toggle('active', t === 'settings');
  }

  /* ---------- 事件 ---------- */
  document.querySelector('.tabs').addEventListener('click', function (e) {
    var b = e.target.closest('.tab'); if (b) setTab(b.dataset.tab);
  });
  $('open-settings').addEventListener('click', function () { setTab(activeTab === 'settings' ? 'detail' : 'settings'); });
  $('view-select').addEventListener('change', function (e) {
    var id = e.target.dataset.pool; if (id) savePrefs({ ballPool: id }, '悬浮球已切换');
  });
  $('view-settings').addEventListener('click', function (e) {
    var t = e.target.closest('[data-theme]');
    if (t) { if (t.dataset.theme !== prefs.theme) savePrefs({ theme: t.dataset.theme }, '外观已切换'); return; }
  });
  function paintRefresh() {
    var b = $('refresh-btn');
    b.className = 'pill-btn refresh' + (scan.busy ? ' busy' : scan.done ? ' done' : '');
    b.textContent = scan.busy ? '刷新中…' : scan.done ? '已刷新' : '刷新数据';
  }
  $('refresh-btn').addEventListener('click', function () {
    if (scan.busy) return;
    scan.busy = true; scan.done = false; paintRefresh();
    var t0 = Date.now();
    QF.refresh().then(function (d) {
      data = d; loadError = null;
      setTimeout(function () {
        scan.busy = false; scan.done = true; renderAll(); paintRefresh(); toast('已刷新');
        setTimeout(function () { scan.done = false; paintRefresh(); }, 1800);
      }, Math.max(0, 500 - (Date.now() - t0)));
    }).catch(function () { scan.busy = false; paintRefresh(); toast('刷新失败，请重试', true); });
  });
  $('view-settings').addEventListener('change', function (e) {
    if (e.target.id === 'autostart') savePrefs({ autostart: e.target.checked }, e.target.checked ? '已开启开机自启' : '已关闭开机自启');
  });
  $('view-usage').addEventListener('change', function (e) {
    var m = { 'f-pool': 'pool', 'f-model': 'model', 'f-day': 'day', 'f-metric': 'metric' }[e.target.id];
    if (m) { dash[m] = e.target.value; dash.page = 0; renderUsage(); }
  });
  $('view-usage').addEventListener('click', function (e) {
    var v = e.target.closest('[data-view]');
    if (v) { dash.view = v.dataset.view; dash.page = 0; renderUsage(); return; }
    var p = e.target.closest('[data-page]');
    if (p && !p.disabled) { dash.page += Number(p.dataset.page); renderUsage(); }
  });
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', function () { if (prefs.theme === 'auto') applyTheme(); });
  }
  QF.onData(function (d) { data = d; loadError = null; renderAll(); });
  QF.onSettings(function (p) { applyPrefs(p); applyTheme(); renderAll(); });

  /* ---------- 初始化 ---------- */
  setTab("detail");
  Promise.all([QF.getSettings(), QF.getData()]).then(function (r) {
    applyPrefs(r[0]); data = r[1]; applyTheme(); renderAll();
  }).catch(function (e) { loadError = '读取数据失败：' + e.message; renderAll(); });
})();
