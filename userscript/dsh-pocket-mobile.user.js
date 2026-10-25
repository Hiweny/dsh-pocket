// ==UserScript==
// @name         DSH Pocket 手机增强
// @namespace    https://github.com/Hiweny/dsh-pocket
// @version      1.1.0
// @description  配合 dsh-pocket 用：键盘弹起时输入框不再被顶歪、Enter 只换行不发送、任务结束提醒、浏览器里也能全屏
// @author       Hiweny
// @homepageURL  https://github.com/Hiweny/dsh-pocket
// @supportURL   https://github.com/Hiweny/dsh-pocket/issues
// @include      http://192.168.*
// @include      http://10.*
// @include      http://172.*
// @include      http://127.0.0.1*
// @include      http://localhost*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * 如果你用公网隧道域名访问（不是内网 IP），在头部 @include 里补一行：
 *   // @include https://你的域名/*
 *
 * 脚本只做四件事，全部在本地完成，不发任何数据出去：
 *   1. 键盘：给 viewport 加 interactive-widget=resizes-content，键盘弹起时
 *      layout viewport 真正缩小，页面里的 composer 就停在键盘正上方；
 *      老内核不支持时退化为「按 visualViewport 高度撑根容器」。
 *   2. Enter：只换行，不发送（发送用输入框自己的按钮）。
 *   3. 通知：监听 dsh 的会话事件流，回合真的结束且你不在页面上时提醒。
 *   4. 全屏：浏览器标签页里点一下页面就进全屏（PWA 已装的话本来就全屏）。
 */
(function () {
  'use strict';

  var W = window;
  var D = document;
  var enabled = false;
  var DEBUG = false;

  function log() {
    if (!DEBUG) return;
    try { console.log.apply(console, ['[dsh-pocket]'].concat([].slice.call(arguments))); } catch (e) { /* ignore */ }
  }

  /* ============================================================
   * 0. 只在 dsh 页面上工作
   * ============================================================ */
  function looksLikeDsh() {
    try {
      if (!D.getElementById('root')) return false;
      var m = D.querySelector('link[rel="manifest"]');
      if (m && /manifest/i.test(m.getAttribute('href') || '')) return true;
      var scripts = D.querySelectorAll('script[src]');
      for (var i = 0; i < scripts.length; i++) {
        if (/\/assets\/index-[\w-]+\.js/.test(scripts[i].src)) return true;
      }
      var el = D.querySelector('[data-phase], [data-dsh-frame]');
      if (el) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  function enable() {
    if (enabled) return;
    if (!looksLikeDsh()) return;
    enabled = true;
    log('enabled');
    injectCss();
    syncViewport(true);
    patchViewportMeta();
    hookViewport();
    installFullscreenTap();
    maybeAskNotifyPermission();
  }

  /* ============================================================
   * 1. 键盘：让 layout viewport 跟着键盘缩
   * ============================================================ */
  var rafPending = false;

  function patchViewportMeta() {
    try {
      var meta = D.querySelector('meta[name="viewport"]');
      if (!meta) return;
      var content = meta.getAttribute('content') || '';
      if (content.indexOf('interactive-widget') !== -1) return;
      // resizes-content：键盘弹起时把 layout viewport 一起缩小（Chrome 108+）。
      // 这是最原生的做法 —— 页面里 100vh、position: fixed 的输入框都会自己落位，
      // 不需要我们再去改高度，也就不会出现「撑起来了但位置错」。
      meta.setAttribute('content', content + ', interactive-widget=resizes-content');
      log('viewport meta patched');
    } catch (e) { /* ignore */ }
  }

  function viewportFixNeeded() {
    var vv = W.visualViewport;
    if (!vv) return false;
    // layout viewport（innerHeight）明显大于可见高度 → 页面是按「全屏高度」布局的，
    // 而键盘把可见区域压小了。这时才需要我们用 CSS 兜底。
    return (W.innerHeight - vv.height) > 60;
  }

  function syncViewport(force) {
    var vv = W.visualViewport;
    var de = D.documentElement;
    if (!de) return;
    var height = vv ? Math.round(vv.height) : Math.round(W.innerHeight);
    var needFix = viewportFixNeeded();
    if (force || needFix) {
      de.style.setProperty('--dsh-vvh', height + 'px');
    }
    if (needFix) {
      de.setAttribute('data-dsh-vvfix', '1');
    } else {
      de.removeAttribute('data-dsh-vvfix');
    }
  }

  function scheduleViewport() {
    if (rafPending) return;
    rafPending = true;
    var run = function () { rafPending = false; syncViewport(false); };
    if (W.requestAnimationFrame) W.requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  function hookViewport() {
    var vv = W.visualViewport;
    if (vv) {
      vv.addEventListener('resize', scheduleViewport);
      vv.addEventListener('scroll', scheduleViewport);
    }
    W.addEventListener('resize', scheduleViewport);
    W.addEventListener('orientationchange', function () { setTimeout(scheduleViewport, 120); });
    // 聚焦输入框后浏览器还会再调一次，补几拍
    D.addEventListener('focusin', function () {
      setTimeout(scheduleViewport, 60);
      setTimeout(scheduleViewport, 260);
      setTimeout(scheduleViewport, 600);
    }, true);
  }

  function injectCss() {
    try {
      if (D.getElementById('dsh-pocket-css')) return;
      var el = D.createElement('style');
      el.id = 'dsh-pocket-css';
      el.textContent = [
        ':root{--dsh-vvh:100vh;}',
        // 兜底：只有 layout viewport 没跟着键盘缩时（老内核）才启用。
        // transform 让 #root 成为 fixed 元素的包含块，composer 的 bottom:0
        // 就是「可见区域底部」而不是「屏幕底部」。
        'html[data-dsh-vvfix] #root{',
        '  height:var(--dsh-vvh)!important;',
        '  transform:translateZ(0);',
        '}',
        'html[data-dsh-vvfix] #root > *{height:100%!important;}',
        // 小细节：去掉点击灰块、关掉橡皮筋回弹
        'html{-webkit-tap-highlight-color:transparent;}',
        'html,body{overscroll-behavior:none;}'
      ].join('\n');
      (D.head || D.documentElement).appendChild(el);
    } catch (e) { /* ignore */ }
  }

  /* ============================================================
   * 2. Enter = 换行（发送交给输入框的按钮）
   * ============================================================ */
  function hookEnterAsNewline() {
    function handle(e) {
      try {
        if (!enabled) return;
        if (e.keyCode !== 13 && e.key !== 'Enter') return;
        if (e.isComposing || e.keyCode === 229) return;        // 中文输入法组词中
        if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
        var t = e.target;
        if (!t) return;
        if (t.tagName !== 'TEXTAREA' && t.isContentEditable !== true) return;
        // 截住页面「Enter 即发送」的处理，但**不** preventDefault，
        // 浏览器默认的插入换行照常发生。
        e.stopImmediatePropagation();
      } catch (err) { /* ignore */ }
    }
    D.addEventListener('keydown', handle, true);
    D.addEventListener('keyup', handle, true);
    D.addEventListener('keypress', handle, true);
  }

  /* ============================================================
   * 3. 回合结束通知
   * ============================================================ */
  var followStreams = {};      // streamId -> sessionId
  var currentSession = '';
  var hasFollowStream = false;
  var turnStartAt = {};
  var lastFrameAt = 0;
  var lastNotifyAt = 0;
  var pendingTimer = null;
  var loadedAt = 0;

  var SNAPSHOT_BYTES = 16384;
  var QUIET_MS = 2600;
  var COOLDOWN_MS = 15000;
  var BOOT_GRACE_MS = 25000;

  function noteContentFrame(size) {
    if (size >= 300) lastFrameAt = Date.now();
  }

  function isGenerating() {
    try {
      var els = D.querySelectorAll(
        '[aria-label*="停止"],[aria-label*="Stop"],[aria-label*="stop"],' +
        '[title*="停止"],[title*="Stop"],[data-testid*="stop"],[class*="stopButton"]'
      );
      for (var i = 0; i < els.length; i++) {
        var r = els[i].getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  function fireNotify() {
    var now = Date.now();
    if (now - loadedAt < BOOT_GRACE_MS) return;
    if (now - lastNotifyAt < COOLDOWN_MS) return;
    if (now - lastFrameAt < QUIET_MS) return;
    if (isGenerating()) return;
    if (D.visibilityState === 'visible') return;   // 你正看着，不打扰
    lastNotifyAt = now;
    notify('任务已完成', '电脑上的 DSH 跑完了，点开看看结果');
  }

  function onTurnEnd(size) {
    if (size > SNAPSHOT_BYTES) return;             // 快照/历史批量
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(function () {
      pendingTimer = null;
      fireNotify();
    }, QUIET_MS + 400);
  }

  function trackClientFrame(raw) {
    if (typeof raw !== 'string' || raw.length < 40) return;
    if (raw.indexOf('session/follow') === -1) return;
    if (raw.indexOf('"open"') === -1) return;
    var obj;
    try { obj = JSON.parse(raw); } catch (e) { return; }
    if (!obj || obj.type !== 'open' || !obj.streamId) return;
    var args = obj.payload && obj.payload.args;
    var req = args && args.request;
    var addr = req && req.address;
    var sid = addr && (addr.sessionId || addr.id);
    followStreams[obj.streamId] = sid || '';
    hasFollowStream = true;
    if (sid) currentSession = sid;
    log('follow', obj.streamId, sid);
  }

  var NEEDLE_TURN = [0x22, 0x74, 0x75, 0x72, 0x6e, 0x2f]; // "turn/

  function containsBytes(u8, needle) {
    var n = needle.length;
    var last = u8.length - n;
    if (last < 0) return false;
    var first = needle[0];
    var i = u8.indexOf(first);
    while (i !== -1 && i <= last) {
      var ok = true;
      for (var k = 1; k < n; k++) {
        if (u8[i + k] !== needle[k]) { ok = false; break; }
      }
      if (ok) return true;
      i = u8.indexOf(first, i + 1);
    }
    return false;
  }

  function handleFrameText(text) {
    if (!text) return;
    noteContentFrame(text.length);
    if (text.indexOf('"turn/') === -1) return;     // 99% 的帧在这里就返回
    var obj;
    try { obj = JSON.parse(text); } catch (e) { return; }
    if (!obj || obj.type !== 'item') return;
    var v = obj.value;
    if (!v || typeof v.type !== 'string') return;
    var isStart = v.type === 'turn/start';
    var isEnd = v.type === 'turn/end';
    if (!isStart && !isEnd) return;

    var sid = followStreams[obj.streamId];
    if (hasFollowStream) {
      // $events 全局流会把别的会话 / 子代理的回合结束也推过来
      if (sid === undefined) return;
      if (currentSession && sid && sid !== currentSession) return;
    }

    if (isStart) {
      turnStartAt[obj.streamId] = Date.now();
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    } else {
      var started = turnStartAt[obj.streamId] || 0;
      if (!started || Date.now() - started < 400) return;
      onTurnEnd(text.length);
    }
  }

  function handleFrameData(data) {
    if (data === null || data === undefined) return;
    if (typeof data === 'string') { handleFrameText(data); return; }
    if (data instanceof ArrayBuffer) {
      try {
        var u8 = new Uint8Array(data);
        noteContentFrame(u8.length);
        if (!containsBytes(u8, NEEDLE_TURN)) return;
        handleFrameText(new TextDecoder('utf-8').decode(u8));
      } catch (e) { /* ignore */ }
      return;
    }
    try {
      if (data && typeof data.text === 'function' && (data.size || 0) < 524288) {
        data.text().then(handleFrameText).catch(function () {});
      }
    } catch (e) { /* ignore */ }
  }

  var wsPatched = false;

  function hookWebSocket() {
    var Native = W.WebSocket;
    if (!Native || wsPatched) return;
    try {
      var proto = Native.prototype;
      var nativeSend = proto.send;
      if (typeof nativeSend === 'function') {
        proto.send = function (data) {
          try { trackClientFrame(data); } catch (e) { /* ignore */ }
          return nativeSend.apply(this, arguments);
        };
      }

      function Patched(url, protocols) {
        var ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
        try {
          ws.addEventListener('message', function (ev) {
            if (!enabled) return;
            handleFrameData(ev && ev.data);
          });
        } catch (e) { /* ignore */ }
        return ws;
      }

      Patched.prototype = Native.prototype;
      Patched.CONNECTING = Native.CONNECTING;
      Patched.OPEN = Native.OPEN;
      Patched.CLOSING = Native.CLOSING;
      Patched.CLOSED = Native.CLOSED;
      W.WebSocket = Patched;
      wsPatched = true;
      log('ws hooked');
    } catch (e) { /* ignore */ }
  }

  /* ---- 通知通道：SW > Notification > 震动/角标/标题 ---- */

  function maybeAskNotifyPermission() {
    try {
      if (typeof Notification === 'undefined') return;
      if (Notification.permission !== 'default') return;
      if (localStorage.getItem('dsh-notify-asked')) return;
      var ask = function () {
        localStorage.setItem('dsh-notify-asked', '1');
        D.removeEventListener('pointerdown', ask, true);
        try { Notification.requestPermission(); } catch (e) { /* ignore */ }
      };
      D.addEventListener('pointerdown', ask, true);
    } catch (e) { /* ignore */ }
  }

  function notify(title, body) {
    var done = false;
    // 1) Service Worker 通道：Android 上真正能弹出系统通知的唯一路径
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
        navigator.serviceWorker.getRegistration().then(function (reg) {
          if (reg && typeof reg.showNotification === 'function') {
            reg.showNotification(title, {
              body: body,
              tag: 'dsh-turn',
              renotify: true,
              icon: '/favicon.svg',
              badge: '/favicon.svg'
            });
          } else {
            fallback();
          }
        }).catch(fallback);
        return;
      }
    } catch (e) { /* ignore */ }

    fallback();

    function fallback() {
      if (done) return;
      done = true;
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification(title, { body: body, tag: 'dsh-turn' });
          return;
        }
      } catch (e) { /* Android 上会抛 Illegal constructor，继续往下 */ }
      try { if (navigator.vibrate) navigator.vibrate([120, 70, 120]); } catch (e) { /* ignore */ }
      try { if (navigator.setAppBadge) navigator.setAppBadge(1); } catch (e) { /* ignore */ }
      flashTitle();
      playBeep();
      log('notify(fallback)', title, body);
    }
  }

  var audioCtx = null;
  function playBeep() {
    try {
      var AC = W.AudioContext || W.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.12, audioCtx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.35);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.38);
    } catch (e) { /* ignore */ }
  }

  var titleFlashed = false;
  function flashTitle() {
    if (titleFlashed) return;
    titleFlashed = true;
    try {
      var base = D.title;
      D.title = '✅ ' + base;
      setTimeout(function () {
        if (D.title === '✅ ' + base) D.title = base;
        titleFlashed = false;
      }, 60000);
    } catch (e) { /* ignore */ }
  }

  /* ============================================================
   * 4. 浏览器里也能全屏（PWA 之外兜底）
   * ============================================================ */
  function isStandalone() {
    try {
      return (W.matchMedia && W.matchMedia('(display-mode: standalone)').matches) ||
        (W.matchMedia && W.matchMedia('(display-mode: fullscreen)').matches) ||
        W.navigator.standalone === true;
    } catch (e) { return false; }
  }

  function installFullscreenTap() {
    if (isStandalone()) return;
    if (!D.documentElement.requestFullscreen) return;
    if (sessionStorage.getItem('dsh-fs-tried')) return;
    var onTap = function () {
      D.removeEventListener('pointerdown', onTap, true);
      try { sessionStorage.setItem('dsh-fs-tried', '1'); } catch (e) { /* ignore */ }
      if (D.fullscreenElement) return;
      setTimeout(function () {
        try {
          var p = D.documentElement.requestFullscreen({ navigationUI: 'hide' });
          if (p && p.catch) p.catch(function () { /* 被拒就算了 */ });
        } catch (e) { /* ignore */ }
      }, 0);
    };
    D.addEventListener('pointerdown', onTap, true);
  }

  /* ============================================================
   * 5. 免密：记住密码页输入的 PIN，cold start 时自动带 ?token= 进去
   * ============================================================ */
  /* dsh-pocket 的代理接受 GET /?token=<PIN> 并立刻种 30 天 cookie，
     所以只要记住 PIN，PWA 每次打开都能自己完成一次登录，
     「dsh web 重启后要重新输密码」这件事对用户就不可见了。 */
  function readSavedPin() {
    try {
      var v = localStorage.getItem('dsh-pin-b64');
      if (!v) return '';
      return atob(v) || '';
    } catch (e) { return ''; }
  }

  function savePin(pin) {
    try { if (pin) localStorage.setItem('dsh-pin-b64', btoa(pin)); } catch (e) { /* ignore */ }
  }

  function handlePinFlow() {
    try {
      var params = new URLSearchParams(location.search);
      var token = params.get('token');
      if (token) { savePin(token); return; }

      var isLoginPage = !!D.querySelector('form[action="/pocket-login"]') ||
        !!D.getElementById('current-password');
      if (!isLoginPage) return;
      if (sessionStorage.getItem('dsh-pin-tried')) return;   // 每个会话只自动试一次，避免死循环

      var pin = readSavedPin();
      if (!pin) return;
      sessionStorage.setItem('dsh-pin-tried', '1');
      location.replace(location.origin + '/?token=' + encodeURIComponent(pin));
    } catch (e) { /* ignore */ }
  }

  function hookPinSubmit() {
    D.addEventListener('submit', function (ev) {
      try {
        var form = ev.target;
        if (!form || !form.querySelector) return;
        var inp = form.querySelector('input[name="token"]') || form.querySelector('#current-password');
        if (inp && inp.value) savePin(String(inp.value));
      } catch (e) { /* ignore */ }
    }, true);
  }

  /* ============================================================
   * 启动
   * ============================================================ */
  hookWebSocket();       // 必须最早：页面脚本一上来就会连 WS
  hookEnterAsNewline();
  hookPinSubmit();
  loadedAt = Date.now();

  if (D.readyState === 'loading') {
    D.addEventListener('DOMContentLoaded', function () { enable(); handlePinFlow(); }, { once: true });
  } else {
    enable();
    handlePinFlow();
  }

  // 兜底：有些站的 #root 是 JS 后才挂上的，重试几次
  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    if (enabled || tries > 20) { clearInterval(timer); return; }
    enable();
  }, 500);
})();
