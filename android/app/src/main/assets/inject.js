/*!
 * DSH Pocket WebView 注入脚本（document-start 执行）
 *
 * 只做四件事，都是低侵入的：
 *   1. 把页面真实背景色告诉原生 —— 窗口/WebView 底色随之同步，
 *      滚动到边界、软键盘顶起、冷启动都不会再露出白边或白闪。
 *   2. hook WebSocket，识别 dsh 的 `turn/end`（回合结束）→ 原生发通知。
 *   3. 记住用户在密码页手动输入的密码，下次直接用 `?token=` 免密进入。
 *   4. 注入极少量 CSS：去掉点击高亮、关掉橡皮筋回弹（overscroll），
 *      视觉零变化，但能少掉一部分重绘与边缘露底。
 */
(function () {
  'use strict';
  try {
    if (window.top !== window) return;             // 只在主文档运行
    if (window.__dshPocketInjected) return;
    window.__dshPocketInjected = 1;

    var W = window;
    var lastBg = '';

    function bridge() {
      try { return W.DSHPocket || null; } catch (e) { return null; }
    }

    /* ---------------- 1. 背景色同步 ---------------- */

    function reportBg() {
      var b = bridge();
      if (!b) return;
      var body = document.body;
      var html = document.documentElement;
      var c = '';
      try { if (body) c = getComputedStyle(body).backgroundColor; } catch (e) { c = ''; }
      if (!c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent') {
        try { if (html) c = getComputedStyle(html).backgroundColor; } catch (e) { c = ''; }
      }
      if (!c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent') return;
      if (c === lastBg) return;
      lastBg = c;
      try { b.setBackground(c); } catch (e) { /* ignore */ }
    }

    function watchTheme() {
      try {
        var mq = W.matchMedia && W.matchMedia('(prefers-color-scheme: dark)');
        if (mq) {
          if (mq.addEventListener) mq.addEventListener('change', reportBg);
          else if (mq.addListener) mq.addListener(reportBg);
        }
      } catch (e) { /* ignore */ }
      try {
        if (!W.MutationObserver || !document.documentElement) return;
        var mo = new MutationObserver(function () { reportBg(); });
        mo.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme', 'data-mode']
        });
        if (document.body) {
          var mo2 = new MutationObserver(function () { reportBg(); });
          mo2.observe(document.body, {
            attributes: true,
            attributeFilter: ['class', 'style', 'data-theme']
          });
        }
      } catch (e) { /* ignore */ }
    }

    /* ---------------- 2. 回合结束 → 通知 ---------------- */

    var loadedAt = Date.now();
    var lastEndAt = 0;
    var decoderOk = true;

    function fireTurnEnd() {
      var now = Date.now();
      if (now - loadedAt < 20000) return;      // 首屏快照里的历史 turn/end，忽略
      if (now - lastEndAt < 4000) return;      // 去重
      lastEndAt = now;
      var b = bridge();
      if (!b) return;
      try { b.onTurnEnd(String(document.title || '')); } catch (e) { /* ignore */ }
    }

    function inspect(text) {
      if (!text || text.length < 6) return;
      if (text.indexOf('turn/end') === -1) return;
      fireTurnEnd();
    }

    function inspectAsync(data) {
      // Blob 形式的帧：异步读取，不阻塞消息回调
      try {
        if (data && typeof data.text === 'function') {
          data.text().then(inspect).catch(function () {});
        }
      } catch (e) { /* ignore */ }
    }

    function hookWebSocket() {
      var Native = W.WebSocket;
      if (!Native || Native.__dshPocketHooked) return;

      function Patched(url, protocols) {
        var ws = protocols === undefined
          ? new Native(url)
          : new Native(url, protocols);
        try {
          ws.addEventListener('message', function (ev) {
            var d = ev && ev.data;
            if (typeof d === 'string') {
              inspect(d);
            } else if (d instanceof ArrayBuffer) {
              try {
                if (d.byteLength > 262144) return;         // 超大帧跳过，控制开销
                inspect(new TextDecoder('utf-8').decode(d));
              } catch (e) { /* ignore */ }
            } else {
              inspectAsync(d);
            }
          });
        } catch (e) { /* ignore */ }
        return ws;
      }

      try {
        Patched.prototype = Native.prototype;
        Patched.CONNECTING = Native.CONNECTING;
        Patched.OPEN = Native.OPEN;
        Patched.CLOSING = Native.CLOSING;
        Patched.CLOSED = Native.CLOSED;
        Patched.__dshPocketHooked = true;
        W.WebSocket = Patched;
      } catch (e) { /* ignore */ }
    }

    /* ---------------- 3. 记住手动输入的密码 ---------------- */

    function hookPinForm() {
      document.addEventListener('submit', function (ev) {
        try {
          var t = ev.target;
          if (!t || !t.querySelector) return;
          var inp = t.querySelector('input[name="token"]') || t.querySelector('#current-password');
          if (inp && inp.value) {
            var b = bridge();
            if (b) b.savePin(String(inp.value));
          }
        } catch (e) { /* ignore */ }
      }, true);
    }

    /* ---------------- 4. 极小 CSS ---------------- */

    function injectCss() {
      try {
        if (document.getElementById('dshpocket-base-css')) return;
        var el = document.createElement('style');
        el.id = 'dshpocket-base-css';
        el.textContent =
          'html{-webkit-tap-highlight-color:transparent;' +
          '-webkit-text-size-adjust:100%;text-size-adjust:100%;}' +
          'html,body{overscroll-behavior:none;}';
        var head = document.head || document.documentElement;
        if (head) head.appendChild(el);
      } catch (e) { /* ignore */ }
    }

    /* ---------------- 启动 ---------------- */

    hookWebSocket();
    hookPinForm();
    injectCss();
    watchTheme();

    document.addEventListener('DOMContentLoaded', function () {
      injectCss();
      reportBg();
      watchTheme();
    }, { once: true });

    window.addEventListener('load', reportBg, { once: true });
    setTimeout(reportBg, 300);
    setTimeout(reportBg, 1200);
    setTimeout(reportBg, 3000);
  } catch (e) { /* 注入失败也不能影响页面 */ }
})();
