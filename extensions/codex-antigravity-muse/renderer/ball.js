(function () {
  'use strict';
  var SHORT = { codex: 'Codex', gemini: 'Gemini', claude_gpt: 'Claude', argon: 'Argon' };
  var $ = function (id) { return document.getElementById(id); };
  var data = null, settings = { theme: 'auto', ballPool: 'codex' }, mode = { mode: 'full', side: null };

  function color(v) { return v >= 50 ? '#28a745' : v >= 20 ? '#c77700' : '#d63a30'; }
  function ballText(v) { return v >= 99.95 ? '100' : v.toFixed(1); }
  function stripText(v) { return v >= 99.95 ? '100' : v >= 99.5 || v < 10 ? v.toFixed(1) : String(Math.round(v)); }
  function pct2(v) { return v.toFixed(2) + '%'; }

  function applyTheme() {
    var dark = settings.theme === 'dark' ||
      (settings.theme === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  }
  /* 5 小时为主、周为辅；没有 5 小时限额的池（Argon）只显示周 */
  function info(pool) {
    if (!pool || pool.status === 'no_data') return null;
    var f = pool.five_hour && pool.five_hour.remaining_pct != null ? pool.five_hour : null;
    var w = pool.weekly && pool.weekly.remaining_pct != null ? pool.weekly : null;
    if (f) return { main: f.remaining_pct, aux: w ? w.remaining_pct : null, mainLabel: '5 小时' };
    if (w) return { main: w.remaining_pct, aux: null, weeklyOnly: true, mainLabel: '周' };
    return null;
  }
  function setRing(id, v) {
    var el = $(id), C = 2 * Math.PI * parseFloat(el.getAttribute('r'));
    el.style.strokeDasharray = C;
    el.style.strokeDashoffset = v == null ? C : C * (1 - Math.max(0, Math.min(100, v)) / 100);
    if (v != null) el.style.stroke = color(v);
  }
  function render() {
    var pools = data ? data.pools : [];
    var pool = pools.filter(function (p) { return p.id === settings.ballPool; })[0] || pools[0];
    var bi = info(pool), hasAux = bi && bi.aux != null;
    var name = pool ? (SHORT[pool.id] || pool.name) : '额度';
    /* 完整球：双环双数字 */
    $('ball-name').textContent = name;
    $('ring-aux').style.display = $('ring-aux-bg').style.display = hasAux ? '' : 'none';
    if (!bi) {
      $('ball-num').textContent = '--'; $('ball-aux').textContent = '';
      setRing('ring-main', null);
    } else {
      $('ball-num').textContent = ballText(bi.main);
      setRing('ring-main', bi.main);
      if (hasAux) setRing('ring-aux', bi.aux);
      $('ball-aux').innerHTML = hasAux ? '周 <b>' + ballText(bi.aux) + '</b>' : (bi.weeklyOnly ? '周限额' : '');
    }
    /* 收起态：第一行 5h（主），第二行周（次） */
    var s = $('strip');
    s.classList.toggle('only', !!(bi && !hasAux));
    if (!bi) {
      $('s1').textContent = pool && pool.status === 'no_data' ? '暂无数据' : '--'; $('s2').textContent = '';
      $('s-edge').style.background = '';
    } else if (hasAux) {
      $('s1').textContent = '5h ' + stripText(bi.main) + '%';
      $('s2').textContent = '周 ' + stripText(bi.aux) + '%';
      $('s-edge').style.background = color(Math.min(bi.main, bi.aux));
    } else {
      $('s1').textContent = '周 ' + stripText(bi.main) + '%'; $('s2').textContent = name;
      $('s-edge').style.background = color(bi.main);
    }
    var tip = pool && bi ? pool.name + ' · ' + bi.mainLabel + '剩余 ' + pct2(bi.main) + (hasAux ? ' · 周剩余 ' + pct2(bi.aux) : '') : '暂无数据';
    $('ball').title = tip; s.title = tip;
  }
  function applyMode() {
    var strip = mode.mode === 'strip';
    $('full').hidden = strip; $('strip').hidden = !strip;
    $('strip').className = 'strip ' + (mode.side === 'right' ? 'right' : 'left') + ($('strip').classList.contains('only') ? ' only' : '');
  }

  /* 拖动：渲染进程只上报屏幕坐标位移，主进程移动窗口并在松手时判断贴边 */
  function wire(el) {
    var down = false, moved = false, sx = 0, sy = 0;
    el.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      down = true; moved = false; sx = e.screenX; sy = e.screenY;
      el.setPointerCapture(e.pointerId); window.QF.ball.dragStart();
    });
    el.addEventListener('pointermove', function (e) {
      if (!down) return;
      var dx = e.screenX - sx, dy = e.screenY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      moved = true; window.QF.ball.dragMove(dx, dy);
    });
    function end(e) {
      if (!down) return;
      down = false;
      try { el.releasePointerCapture(e.pointerId); } catch (x) { /* 忽略 */ }
      window.QF.ball.dragEnd();
      if (!moved && e.type === 'pointerup') window.QF.ball.click();
    }
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }
  wire($('ball')); wire($('strip'));

  window.QF.onData(function (d) { data = d; render(); });
  window.QF.onSettings(function (s) { settings = s; applyTheme(); render(); });
  window.QF.onBallMode(function (m) { mode = m; render(); applyMode(); });
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', applyTheme);
  }
  Promise.all([window.QF.getData(), window.QF.getSettings(), window.QF.getBallMode()]).then(function (r) {
    data = r[0]; settings = r[1]; mode = r[2]; applyTheme(); render(); applyMode();
  });
})();
