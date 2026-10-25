# DSH Pocket · 油猴脚本（手机浏览器用）

给 [dsh-pocket](https://github.com/shaobeichen/dsh-pocket) 的手机入口加四件事，**不套壳、不改服务端**，浏览器里直接跑：

| 问题 | 做法 |
| --- | --- |
| 键盘弹起后输入框「撑起来了但位置不对」 | 给 viewport 加 `interactive-widget=resizes-content`（Chrome 108+），让 **layout viewport 跟着键盘一起缩**，页面里的 `100vh` / `position: fixed` 自己就落位了；老内核不支持时退化为「按 `visualViewport.height` 撑 `#root` + `translateZ(0)` 让 fixed 相对可见区域」 |
| Enter 被当成发送 | 在 document 捕获阶段截住 Enter（不 `preventDefault`），页面收不到「发送」，浏览器默认插入换行照常发生；发送用输入框自己的按钮。中文输入法组词中的 Enter、Shift/Ctrl 组合键一律放行 |
| 任务跑完了没人告诉你 | 监听 dsh 的会话事件流，**只认当前会话 `session/follow` 流里的小帧 `turn/end`**，忽略 `$events` 全局流（别的会话/子代理）与历史快照，并要求结束后真的静止 2.6s、页面上没有「停止」按钮、15s 冷却 |
| 打开主屏幕图标进的是浏览器 | 见下面「PWA 全屏」——脚本能做兜底全屏，但安装方式得你在浏览器菜单里点对 |
| 免密进入 | 记住密码页输过的 PIN，下次打开自动带 `?token=` 完成一次登录（dsh web 重启也不用再手输） |

## 安装

1. 装一个支持油猴脚本的浏览器：
   - **Edge Android**：扩展里启用 Tampermonkey（部分版本需要 Beta / 手动开启扩展支持）
   - 或 Kiwi / Firefox Android + Tampermonkey
2. 打开脚本地址，Tampermonkey 会弹出安装页：

   ```
   https://raw.githubusercontent.com/Hiweny/dsh-pocket/main/userscript/dsh-pocket-mobile.user.js
   ```

   国内访问 raw 不顺可以用代理：

   ```
   https://gh.geekertao.top/https://raw.githubusercontent.com/Hiweny/dsh-pocket/main/userscript/dsh-pocket-mobile.user.js
   ```

3. 用手机访问电脑上的 `http://192.168.x.x:3081`，脚本自动生效。

**默认只匹配内网段**（`192.168.*` / `10.*` / `172.*` / `127.0.0.1` / `localhost`）。
如果你用公网隧道域名访问，在脚本头部加一行：

```js
// @include https://你的域名/*
```

## 关于「PWA 全屏」

**脚本无法控制浏览器的安装行为**——「添加到主屏幕」是快捷方式还是真正的 PWA，由浏览器的菜单项决定，页面脚本没有权限干预。

好消息是：DSH 自己的 manifest（`/manifest.webmanifest`）**已经是 `display: fullscreen`**，所以只要装的是 **PWA（WebAPK / 安装应用）**，打开就是全屏沉浸、没有地址栏。

- Edge / Chrome 里请用菜单里的「**安装应用 / 添加到主屏幕（安装）**」，而不是「添加到手机」那种纯快捷方式；
- 如果之前装过快捷方式，先删掉再从菜单里重新「安装应用」。

万一装不成（或者你只想在标签页里用），脚本还有一个兜底：**不在 PWA 模式时，你在页面上点第一下，就会请求进入全屏**（Fullscreen API，隐藏浏览器 UI）。按系统返回键退出全屏，页面不会丢。

## 关于「通知」

说清楚这边的能力边界，免得期待落空：

- **桌面浏览器**：`Notification` API 可用，能弹系统通知；
- **Android 浏览器**：Chromium 禁止网页直接 `new Notification()`，**只有通过 Service Worker 的 `showNotification` 才能发系统通知**。DSH 目前没有注册 Service Worker，所以手机上拿不到真正的系统通知；
- 脚本会按优先级自适应：有 SW 就用 `showNotification` → 否则 `Notification` → 再否则退化为**震动 + 页面标题前加 ✅ + 应用角标（`setAppBadge`，PWA 已安装时生效）+ 一声短提示音**。

如果你要的是"手机放兜里、任务完了响一下"，那还是得走 APK（原生通知不受这个限制）。

## 会不会影响其它网站

不会。脚本只在上面那些内网地址上运行，并且还会再确认一次「这个页面是不是 DSH」（有 `#root` + manifest 指向 `*.webmanifest` 或 `/assets/index-*.js`），不是就不做任何事。

## 排查

脚本里有个 `DEBUG` 常量，改成 `true` 后可以在控制台看到 `[dsh-pocket]` 开头的日志（是否启用、hook 到哪条流、通知走了哪条通道）。
