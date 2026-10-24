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

    /* ---------------- 0. 旧内核兼容垫片 ----------------
     * DSH 前端是 Vite 构建的现代 bundle，不降级运行时 API。部分手机（尤其
     * 系统 WebView 偏旧）会缺下面这些方法，典型表现是「发送消息报
     * AbortSignal.any is not a function」「复制按钮没反应」。这里只补
     * 不存在的，已有实现一律不覆盖。
     */
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
        if (!AP.toSorted) {
          AP.toSorted = function (cmp) { return this.slice().sort(cmp); };
        }
        if (!AP.toSpliced) {
          AP.toSpliced = function (start, del) {
            var copy = this.slice();
            var args = Array.prototype.slice.call(arguments);
            Array.prototype.splice.apply(copy, args);
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

        var P = window.Promise;
        if (P && !P.withResolvers) {
          P.withResolvers = function () {
            var resolve, reject;
            var promise = new P(function (res, rej) { resolve = res; reject = rej; });
            return { promise: promise, resolve: resolve, reject: reject };
          };
        }
        if (P && !P.try) {
          P.try = function (fn) {
            var args = Array.prototype.slice.call(arguments, 1);
            return new P(function (resolve) { resolve(fn.apply(null, args)); });
          };
        }

        if (typeof AbortSignal !== 'undefined') {
          if (!AbortSignal.any) {
            AbortSignal.any = function (signals) {
              var ctrl = new AbortController();
              var list = Array.prototype.slice.call(signals || []);
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

        // 明文 http（局域网）不是安全上下文，这两样在新内核上也可能是 undefined
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
      } catch (e) { /* ignore */ }
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

    shimLegacy();
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
