# DSH Pocket · Android

把 [dsh-pocket](https://github.com/shaobeichen/dsh-pocket) 的手机入口打包成一个**全屏沉浸式**的安卓客户端。

电脑上照旧跑 `dsh web` + dsh-pocket 插件，手机上装这个 APK，填地址（或扫码）就能用。

## 做了什么

| 需求 | 实现 |
| --- | --- |
| 输入网址 / 扫码 | 首次配置页支持手输地址，也可以直接扫电脑上「设置 → 手机访问」的二维码（CameraX + zxing） |
| 密码持久化 | 访问密码用 Android Keystore 里的 AES-256-GCM 密钥加密保存，下次打开直接用 `?token=` 免密进入；若密码改过，在密码页手输一次会自动更新保存 |
| 全屏沉浸 | `WindowCompat.setDecorFitsSystemWindows(false)` + 隐藏系统栏 + `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE`，页面铺满整屏 |
| 顶部/底部无白线 | 注入脚本把页面真实背景色回报原生，窗口 / WebView / loading 遮罩三层同步同一个颜色；关掉系统栏对比度底衬；`overScrollMode=NEVER` + `overscroll-behavior:none` 去橡皮筋露底 |
| 不加多余按钮 | 主界面只有 WebView。改地址的入口藏在顶部安全区（刘海那一条）**双击**；页面打不开时会出现「检查地址」 |
| 输入框能撑起来 | 交给系统 `adjustResize` 直接缩小窗口内容区（`setDecorFitsSystemWindows(true)` + 隐藏系统栏），WebView 的 viewport 一次性变矮，composer 自然上移。**不手动逐帧改高度**——那会带来逐帧重排、闪两下和输入卡顿 |
| Enter 只换行 | 注入脚本在 document 捕获阶段截住 Enter（不 `preventDefault`），页面收不到「发送」，浏览器默认插入换行照常发生；Shift/Ctrl 组合键与输入法组词中的 Enter 一律放行 |
| 不闪、不卡 | 冷启动用上次页面底色做窗口底色（不闪白）；`textZoom` 固定 100 避免系统字号导致重排；点击高亮关闭；`rendererPriority=IMPORTANT` 保证后台仍能收流式数据；渲染进程被回收自动重建 WebView。<br>注入脚本刻意保持“零高频开销”：背景色同步走 `requestAnimationFrame` 节流（绝不在高频回调里 `getComputedStyle`）、WebSocket 帧用字节级 `turn/end` 匹配（200KB 帧 ~0.06ms，零解码零分配）、document-start 注入成功就不再重复注入 |
| 通知 | hook 页面 WebSocket，**只认当前会话 `session/follow` 流里的小帧 `turn/end`**：忽略 `$events` 全局流（会把别的会话/子代理的回合结束也算进来）、忽略快照大帧（>16KB，历史记录里全是旧 turn/end）、要求 turn/end 之后真的静止 2.6s、页面上没有「停止」按钮、并且 15s 冷却。这样任务没跑完不会提前通知 |
| 流式生成不卡 | 「流畅优先」开关（默认开）：给滚动容器的直接子项加 `content-visibility:auto` + `contain-intrinsic-size:auto`，屏外消息不参与渲染/布局——agent 连调几十个工具时 DOM 很长，这一步能把每次插入引起的整列重排削掉大半；同时把滚动容器的 `scroll-behavior` 改回 `auto`，流式输出的连续平滑滚动不再堆成动画队列 |

## 关于「卡」

先看配置页底部那行 `WebView Chromium xxx`。DSH 前端是 Vite 构建的现代 bundle，
Chromium < 94 连 `static {}`、`??=` 都解析不了（白屏），< 100 左右在长会话流式输出时也会明显吃力。
低于 94 时 App 会直接给出提示页而不是白屏。真想彻底解决老机器，只能走「复用手机上更新的内核 / 内置 Chromium」那条路，
代价是包体从 3MB 涨到 70–110MB。

## 本地构建

```sh
cd android
export ANDROID_HOME=/path/to/android-sdk      # 需要 platform 34 + build-tools 34.0.0
export DSH_VERSION_NAME=1.0.0 DSH_VERSION_CODE=1
gradle assembleRelease
```

签名（可选，不提供则用 debug 签名）：

```sh
export DSH_KEYSTORE=/path/to/release.jks
export DSH_KEYSTORE_PASSWORD=…
export DSH_KEY_ALIAS=…
export DSH_KEY_PASSWORD=…
```

## CI

`.github/workflows/android.yml`：打 `v*` tag 自动构建并发布 Release，也可以手动 Run workflow 只出 artifact。

## 说明

- 这是社区 WebView 壳，不是 DSH 官方客户端，必须配合 dsh-pocket 插件使用。
- 局域网地址是明文 http，明文流量已放行；访问密码只存在手机本地（加密）。
