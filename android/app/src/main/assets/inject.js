/*!
 * DSH Pocket WebView 注入脚本（document-start 执行）
 *
 * 这个脚本会被流式输出时每秒几十上百次的 WebSocket 帧打到，
 * 所以每一处都必须「先做最便宜的判断，再考虑解析」。
 *
 * 六件事：
 *   0. 旧内核兼容垫片（只补不存在的 API）
 *   1. 回报页面真实背景色（rAF 节流，绝不在高频回调里 getComputedStyle）
 *   2. 长会话性能：屏外消息不参与渲染（content-visibility），可被 App 关闭
 *   3. 回合结束通知：只认「当前会话的 follow 流」+ 小帧 + 静止确认 + 生成中检测
 *   4. Enter 只换行，不发送
 *   5. 记住密码页手输的密码
 */
(function () {
  'use strict';
  try {
    if (window.top !== window) return;
    if (window.__dshPocketInjected) return;
    window.__dshPocketInjected = 1;

    var W = window;

    function bridge() {
      try { return W.DSHPocket || null; } catch (e) { return null; }
    }

    /* ================= 0. 旧内核兼容垫片 ================= */
    function shimLegacy() {
      try {
        var AP = Array.prototype;
        function at(n) {
          var len = this.length >>> 0;
          var i = Math.trunc(n) || 0;
          if (i < 0) i += len;
          return (i < 0 || i >= len) ? undefined : this[i];
        }
        if (!AP.at) AP.at = at;
        if (typeof String !== 'undefined' && !String.prototype.at) String.prototype.at = at;
        if (!AP.findLast) {
          AP.findLast = function (fn, thisArg) {
            for (var i = this.length - 1; i >= 0; i--) {
              if (fn.call(thisArg, this[i], i, this)) return this[i];
            }
            return undefined;
          };
        }
        if (!AP.findLastIndex) {
          AP.findLastIndex = function (fn, thisArg) {
            for (var i = this.length - 1; i >= 0; i--) {
              if (fn.call(thisArg, this[i], i, this)) return i;
            }
            return -1;
          };
        }
        if (!AP.toReversed) AP.toReversed = function () { return this.slice().reverse(); };
        if (!AP.toSorted) AP.toSorted = function (cmp) { return this.slice().sort(cmp); };
        if (!AP.toSpliced) {
          AP.toSpliced = function () {
            var copy = this.slice();
            Array.prototype.splice.apply(copy, Array.prototype.slice.call(arguments));
            return copy;
          };
        }
        if (!AP.with) {
          AP.with = function (index, value) {
            var copy = this.slice();
            var i = index < 0 ? copy.length + index : index;
            if (i < 0 || i >= copy.length) throw new RangeError('Invalid index');
            copy[i] = value;
            return copy;
          };
        }
        if (!String.prototype.replaceAll) {
          String.prototype.replaceAll = function (pattern, replacement) {
            if (pattern instanceof RegExp) {
              if (!pattern.global) throw new TypeError('replaceAll requires a global RegExp');
              return this.replace(pattern, replacement);
            }
            var s = String(this);
            var p = String(pattern);
            if (typeof replacement === 'function') {
              var out = '';
              var from = 0;
              var idx;
              while ((idx = s.indexOf(p, from)) !== -1) {
                out += s.slice(from, idx) + replacement(p, idx, s);
                from = idx + p.length;
              }
              return out + s.slice(from);
            }
            return s.split(p).join(String(replacement));
          };
        }
        if (!Object.hasOwn) {
          Object.hasOwn = function (obj, key) {
            return Object.prototype.hasOwnProperty.call(obj, key);
          };
        }
        if (!URL.canParse) {
          URL.canParse = function (url, base) {
            try { new URL(url, base); return true; } catch (e) { return false; }
          };
        }

        var P = W.Promise;
        if (P && !P.withResolvers) {
          P.withResolvers = function () {
            var resolve, reject;
            var promise = new P(function (res, rej) { resolve = res; reject = rej; });
            return { promise: promise, resolve: resolve, reject: reject };
          };
        }
        if (P && !P.try) {
          P.try = function (fn) {
            var args = AP.slice.call(arguments, 1);
            return new P(function (resolve) { resolve(fn.apply(null, args)); });
          };
        }

        if (typeof AbortSignal !== 'undefined') {
          if (!AbortSignal.any) {
            AbortSignal.any = function (signals) {
              var ctrl = new AbortController();
              var list = AP.slice.call(signals || []);
              for (var i = 0; i < list.length; i++) {
                var sig = list[i];
                if (!sig) continue;
                if (sig.aborted) {
                  try { ctrl.abort(sig.reason); } catch (e) { ctrl.abort(); }
                  return ctrl.signal;
                }
                sig.addEventListener('abort', function () {
                  try { ctrl.abort(this.reason); } catch (e) { ctrl.abort(); }
                });
              }
              return ctrl.signal;
            };
          }
          if (!AbortSignal.timeout) {
            AbortSignal.timeout = function (ms) {
              var ctrl = new AbortController();
              setTimeout(function () {
                try { ctrl.abort(new DOMException('TimeoutError', 'TimeoutError')); }
                catch (e) { ctrl.abort(); }
              }, ms);
              return ctrl.signal;
            };
          }
        }

        if (typeof crypto !== 'undefined' && !crypto.randomUUID && crypto.getRandomValues) {
          crypto.randomUUID = function () {
            var b = new Uint8Array(16);
            crypto.getRandomValues(b);
            b[6] = (b[6] & 0x0f) | 0x40;
            b[8] = (b[8] & 0x3f) | 0x80;
            var h = [];
            for (var i = 0; i < 16; i++) h.push((b[i] + 0x100).toString(16).slice(1));
            return h[0] + h[1] + h[2] + h[3] + '-' + h[4] + h[5] + '-' + h[6] + h[7] +
              '-' + h[8] + h[9] + '-' + h[10] + h[11] + h[12] + h[13] + h[14] + h[15];
          };
        }
        if (typeof navigator !== 'undefined' && !navigator.clipboard) {
          try {
            Object.defineProperty(navigator, 'clipboard', {
              configurable: true,
              value: {
                writeText: function (text) {
                  return new Promise(function (resolve, reject) {
                    try {
                      var ta = document.createElement('textarea');
                      ta.value = text;
                      ta.setAttribute('readonly', '');
                      ta.style.position = 'fixed';
                      ta.style.opacity = '0';
                      document.body.appendChild(ta);
                      ta.select();
                      var ok = document.execCommand('copy');
                      document.body.removeChild(ta);
                      ok ? resolve() : reject(new Error('copy failed'));
                    } catch (e) { reject(e); }
                  });
                },
                readText: function () { return Promise.reject(new Error('unsupported')); }
              }
            });
          } catch (e) { /* ignore */ }
        }
      } catch (e) { /* 注入失败也不能影响页面 */ }
    }

    /* ================= 1. 背景色同步 ================= */
    var lastBg = '';
    var bgScheduled = false;

    function reportBgNow() {
      var b = bridge();
      if (!b) return;
      var c = '';
      try {
        var body = document.body;
        if (body) c = getComputedStyle(body).backgroundColor;
        if (!c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent') {
          var html = document.documentElement;
          if (html) c = getComputedStyle(html).backgroundColor;
        }
      } catch (e) { return; }
      if (!c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent') return;
      if (c === lastBg) return;
      lastBg = c;
      try { b.setBackground(c); } catch (e) { /* ignore */ }
    }

    function reportBg() {
      if (bgScheduled) return;
      bgScheduled = true;
      var run = function () { bgScheduled = false; reportBgNow(); };
      if (W.requestAnimationFrame) W.requestAnimationFrame(run);
      else setTimeout(run, 60);
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
        if (!W.MutationObserver) return;
        var mo = new MutationObserver(function () { reportBg(); });
        mo.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme', 'data-mode']
        });
      } catch (e) { /* ignore */ }
    }

    /* ================= 2. 长会话渲染优化 ================= */
    /* content-visibility:auto 让「滚出屏幕的消息」跳过渲染与布局。
       agent 一口气调用几十个工具时，DOM 会变得很长，浏览器每次插入内容
       都要为整列重新布局 —— 跳过屏外内容能把成本削掉一大截。
       仅作用于滚动容器的直接子项，由 App 侧「流畅优先」开关控制。 */
    var perfApplied = false;

    function smoothEnabled() {
      try {
        var b = bridge();
        if (b && typeof b.smoothMode === 'function') return !!b.smoothMode();
      } catch (e) { /* ignore */ }
      return true;
    }

    function injectPerfCss() {
      if (perfApplied) return;
      if (!smoothEnabled()) return;
      try {
        if (document.getElementById('dshpocket-perf-css')) { perfApplied = true; return; }
        var el = document.createElement('style');
        el.id = 'dshpocket-perf-css';
        el.textContent =
          // 流式输出时禁用平滑滚动：内容每帧都在长，smooth 会变成连续动画
          '[class*="scrollBody"]{scroll-behavior:auto !important;}' +
          // 屏外消息不渲染；contain-intrinsic-size 的 auto 会记住已渲染高度，
          // 滚回去不会跳。两行是给新旧内核的降级写法。
          '[class*="scrollBody"] > *{' +
            'content-visibility:auto;' +
            'contain-intrinsic-size:320px;' +
            'contain-intrinsic-size:auto 320px;' +
          '}';
        var head = document.head || document.documentElement;
        if (head) {
          head.appendChild(el);
          perfApplied = true;
        }
      } catch (e) { /* ignore */ }
    }

    /* ================= 3. 回合结束 → 通知 ================= */
    /* 曾经的误发来源：
         a) 全局事件流（$events）会把「任何会话」的 turn/end 都推过来；
         b) 切换/重连时的 snapshot 里带着历史 turn/end；
         c) 一个回合内有多次状态推送。
       现在只认「当前会话 follow 流」+ 小帧 + 之后真的静止 + 页面没有停止按钮。 */
    var followStreams = {};        // streamId -> sessionId（session/follow 开的流）
    var currentSession = '';
    var hasFollowStream = false;
    var turnStartAt = {};          // streamId -> 最近一次 turn/start 时间
    var lastFrameAt = 0;           // 最近一次「有内容」的帧时间
    var lastNotifyAt = 0;
    var pendingTimer = null;
    var loadedAt = Date.now();

    var SNAPSHOT_BYTES = 16384;    // 超过这个大小的帧基本是快照/历史批量
    var QUIET_MS = 2600;           // turn/end 之后要静止多久才算真结束
    var COOLDOWN_MS = 15000;

    function noteContentFrame(size) {
      // 小控制帧（心跳之类）不参与「静默」判定
      if (size >= 300) lastFrameAt = Date.now();
    }

    function isGenerating() {
      try {
        var els = document.querySelectorAll(
          '[aria-label*="停止"],[aria-label*="Stop"],[aria-label*="stop"],' +
          '[title*="停止"],[title*="Stop"],[data-testid*="stop"],[class*="stopButton"]'
        );
        for (var i = 0; i < els.length; i++) {
          var el = els[i];
          var r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return true;
        }
      } catch (e) { /* ignore */ }
      return false;
    }

    function fireNotify() {
      var now = Date.now();
      if (now - loadedAt < 25000) return;
      if (now - lastNotifyAt < COOLDOWN_MS) return;
      if (now - lastFrameAt < QUIET_MS) return;   // 还在流
      if (isGenerating()) return;                 // 页面上还有停止按钮
      lastNotifyAt = now;
      var b = bridge();
      if (!b) return;
      try { b.onTurnEnd(String(document.title || '')); } catch (e) { /* ignore */ }
    }

    function onTurnEnd(size) {
      if (size > SNAPSHOT_BYTES) return;          // 快照 / 历史批量
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = setTimeout(function () {
        pendingTimer = null;
        fireNotify();
      }, QUIET_MS + 400);
    }

    function trackClientFrame(raw) {
      // 只关心「开一条会话订阅」的帧，用来建立 streamId → sessionId 的映射
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
    }

    function handleFrameText(text) {
      if (!text) return;
      noteContentFrame(text.length);
      // 99% 的帧在这里就返回了：一次 indexOf，不做任何解析
      if (text.indexOf('"turn/') === -1) return;
      var obj;
      try { obj = JSON.parse(text); } catch (e) { return; }
      if (!obj || obj.type !== 'item') return;
      var v = obj.value;
      if (!v || typeof v.type !== 'string') return;
      var isTurnStart = v.type === 'turn/start';
      var isTurnEnd = v.type === 'turn/end';
      if (!isTurnStart && !isTurnEnd) return;

      var sid = followStreams[obj.streamId];
      if (hasFollowStream) {
        // 认不出映射的流（比如 $events 全局流）一律不算：那会把别的会话、
        // 子代理的回合结束当成「你的任务完成了」。
        if (sid === undefined) return;
        if (currentSession && sid && sid !== currentSession) return;
      }

      if (isTurnStart) {
        turnStartAt[obj.streamId] = Date.now();
        if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
      } else {
        var started = turnStartAt[obj.streamId] || 0;
        if (!started || Date.now() - started < 400) return;
        onTurnEnd(text.length);
      }
    }

    var NEEDLE_TURN = new Uint8Array([0x22, 0x74, 0x75, 0x72, 0x6e, 0x2f]); // "turn/

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

    function handleFrameData(data) {
      if (data === null || data === undefined) return;
      if (typeof data === 'string') {
        handleFrameText(data);
        return;
      }
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
        // 1) 记录客户端发出的 session/follow（建流帧很小、频率极低）
        var proto = Native.prototype;
        var nativeSend = proto.send;
        if (typeof nativeSend === 'function') {
          proto.send = function (data) {
            try { trackClientFrame(data); } catch (e) { /* ignore */ }
            return nativeSend.apply(this, arguments);
          };
        }

        // 2) 收帧
        function Patched(url, protocols) {
          var ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
          try {
            ws.addEventListener('message', function (ev) {
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
      } catch (e) { /* ignore */ }
    }

    /* ================= 4. Enter = 换行 ================= */
    function hookEnterAsNewline() {
      document.addEventListener('keydown', function (e) {
        try {
          if (e.keyCode !== 13 && e.key !== 'Enter') return;
          if (e.isComposing || e.keyCode === 229) return;
          if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
          var t = e.target;
          if (!t) return;
          if (t.tagName !== 'TEXTAREA' && t.isContentEditable !== true) return;
          // 截住页面把 Enter 当发送的处理，但不 preventDefault ——
          // 浏览器默认的「插入换行」照常发生。
          e.stopImmediatePropagation();
        } catch (err) { /* ignore */ }
      }, true);
    }

    /* ================= 5. 记住手输的密码 ================= */
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

    /* ================= 6. 极小 CSS ================= */
    function injectBaseCss() {
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

    /* ================= 启动 ================= */
    shimLegacy();
    hookWebSocket();
    hookEnterAsNewline();
    hookPinForm();
    injectBaseCss();
    watchTheme();

    document.addEventListener('DOMContentLoaded', function () {
      injectBaseCss();
      injectPerfCss();
      reportBg();
      watchTheme();
    }, { once: true });

    window.addEventListener('load', function () {
      injectPerfCss();
      reportBg();
    }, { once: true });

    setTimeout(function () { injectPerfCss(); reportBg(); }, 400);
    setTimeout(function () { injectPerfCss(); reportBg(); }, 1600);
  } catch (e) { /* 注入失败也不能影响页面 */ }
})();
