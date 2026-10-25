/*!
 * DSH Pocket WebView 注入脚本（document-start 执行）
 *
 * 原则：能少做就少做。这个脚本会在流式输出时被成千上万次事件打到，
 * 任何一次多余的解码 / 强制样式计算都会变成用户能感觉到的卡顿。
 *
 * 做五件事：
 *   0. 旧内核兼容垫片（只补不存在的方法，不覆盖已有实现）
 *   1. 回报页面真实背景色（原生据此同步窗口底色，消除白边/白闪）
 *   2. 识别 dsh 的 `turn/end`（回合结束）→ 原生发通知（字节级匹配，零解码）
 *   3. Enter 只换行、不发送（发送交给输入框自己的按钮）
 *   4. 记住密码页里手输的密码，下次直接用 ?token= 免密进入
 */
(function () {
  'use strict';
  try {
    if (window.top !== window) return;            // 只在主文档运行
    if (window.__dshPocketInjected) return;       // 幂等
    window.__dshPocketInjected = 1;

    var W = window;

    function bridge() {
      try { return W.DSHPocket || null; } catch (e) { return null; }
    }

    /* ================= 0. 旧内核兼容垫片 ================= */
    /* Vite 只降语法、不 polyfill 运行时 API。缺这些方法时页面表现为
       「发送消息报 AbortSignal.any is not a function」或按钮点了没反应。 */
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

        // 明文 http（局域网）不是安全上下文，这两样在新内核上也可能没有
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

    /* ================= 1. 背景色同步（节流 + rAF） ================= */
    /* 注意：绝不能在任何高频回调里直接 getComputedStyle —— 那会强制同步
       样式计算，打字时会明显卡。这里统一丢进 rAF，一帧最多算一次。 */
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
      var run = function () {
        bgScheduled = false;
        reportBgNow();
      };
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
        // 只盯根元素，且只盯会和主题相关的属性；
        // 不观察 body（流式输出时属性变化太频繁，会把样式计算打爆）。
        var mo = new MutationObserver(function () { reportBg(); });
        mo.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme', 'data-mode']
        });
      } catch (e) { /* ignore */ }
    }

    /* ================= 2. 回合结束 → 通知 ================= */
    var loadedAt = Date.now();
    var lastEndAt = 0;
    // "turn/end" 的 ASCII 字节，做零分配匹配
    var NEEDLE = new Uint8Array([0x74, 0x75, 0x72, 0x6e, 0x2f, 0x65, 0x6e, 0x64]);

    function fireTurnEnd() {
      var now = Date.now();
      if (now - loadedAt < 20000) return;      // 首屏快照里的历史 turn/end
      if (now - lastEndAt < 4000) return;      // 去重
      lastEndAt = now;
      var b = bridge();
      if (!b) return;
      try { b.onTurnEnd(String(document.title || '')); } catch (e) { /* ignore */ }
    }

    function hasTurnEnd(u8) {
      var n = NEEDLE.length;
      var last = u8.length - n;
      if (last < 0) return false;
      var first = NEEDLE[0];
      var i = u8.indexOf(first);
      while (i !== -1 && i <= last) {
        var ok = true;
        for (var k = 1; k < n; k++) {
          if (u8[i + k] !== NEEDLE[k]) { ok = false; break; }
        }
        if (ok) return true;
        i = u8.indexOf(first, i + 1);
      }
      return false;
    }

    function inspect(data) {
      if (data === null || data === undefined) return;
      if (typeof data === 'string') {
        if (data.length > 8 && data.indexOf('turn/end') !== -1) fireTurnEnd();
        return;
      }
      if (data instanceof ArrayBuffer) {
        // 纯字节扫描：不解码、不建字符串，流式帧也不会拖慢主线程
        try { if (hasTurnEnd(new Uint8Array(data))) fireTurnEnd(); } catch (e) { /* ignore */ }
        return;
      }
      // Blob 帧（少见）：异步读字节，超大帧直接跳过
      try {
        if (data && typeof data.arrayBuffer === 'function' && (data.size || 0) < 2097152) {
          data.arrayBuffer().then(function (buf) {
            try { if (hasTurnEnd(new Uint8Array(buf))) fireTurnEnd(); } catch (e) { /* ignore */ }
          }).catch(function () {});
        }
      } catch (e) { /* ignore */ }
    }

    function hookWebSocket() {
      var Native = W.WebSocket;
      if (!Native || Native.__dshPocketHooked) return;

      function Patched(url, protocols) {
        var ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
        try {
          ws.addEventListener('message', function (ev) {
            inspect(ev && ev.data);
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

    /* ================= 3. Enter = 换行，不发送 ================= */
    /* 页面自己在 keydown 里把 Enter 当发送；我们在 document 捕获阶段截住，
       但不 preventDefault —— 浏览器默认的「插入换行」照常发生。
       带修饰键（Shift/Ctrl/Alt/Cmd）与输入法组词中的 Enter 一律放行。 */
    function hookEnterAsNewline() {
      document.addEventListener('keydown', function (e) {
        try {
          var isEnter = e.key === 'Enter' || e.keyCode === 13;
          if (!isEnter) return;
          if (e.isComposing || e.keyCode === 229) return;   // 中文输入法组词中
          if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
          var t = e.target;
          if (!t) return;
          var multiline = t.tagName === 'TEXTAREA' || t.isContentEditable === true;
          if (!multiline) return;
          e.stopImmediatePropagation();
        } catch (err) { /* ignore */ }
      }, true);
    }

    /* ================= 4. 记住手输的密码 ================= */
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

    /* ================= 5. 极小 CSS ================= */
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

    /* ================= 启动 ================= */
    shimLegacy();
    hookWebSocket();
    hookEnterAsNewline();
    hookPinForm();
    injectCss();
    watchTheme();

    document.addEventListener('DOMContentLoaded', function () {
      injectCss();
      reportBg();
      watchTheme();
    }, { once: true });

    window.addEventListener('load', reportBg, { once: true });
    setTimeout(reportBg, 400);
    setTimeout(reportBg, 1500);
  } catch (e) { /* 注入失败也不能影响页面 */ }
})();
