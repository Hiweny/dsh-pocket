package com.hiweny.dshpocket

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.URLUtil
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.BufferedReader

/**
 * 主界面：一个全屏沉浸的 WebView，页面就是 dsh-pocket 的手机入口。
 *
 * 设计约束（按需求）：
 *  - 不额外加任何常驻按钮，全屏只有页面本身；
 *  - 顶部/底部不能出现白线：窗口、WebView、页面三层底色始终同步；
 *  - 键盘弹起时页面要跟着「撑起来」，并且是跟随系统动画平滑变化；
 *  - 冷启动不闪白：用上次页面底色做启动窗口底色 + 同色加载遮罩。
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "DSHPocket"
        private const val REQ_NOTIF = 1001
        private const val OVERLAY_FADE_MS = 150L

        /** 配置页改完地址后带回来，让当前 WebView 重新加载。 */
        const val EXTRA_RELOAD = "dsh_reload"
    }

    private lateinit var prefs: Prefs
    private lateinit var root: FrameLayout
    private var webView: WebView? = null
    private var loadingOverlay: View? = null
    private var errorOverlay: View? = null
    private var hotspot: View? = null

    private var bgColor: Int = 0
    private var safeTop = 0
    private var safeBottom = 0
    private var imeH = 0
    private var imeFallbackApplied = false
    private var resumed = false
    private var mainFrameError = false
    private var docStartOk = false
    private var lastBackAt = 0L
    private val handler = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        if (!prefs.configured) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }

        bgColor = if (prefs.lastBg != 0) prefs.lastBg
        else ContextCompat.getColor(this, R.color.window_bg)

        // 必须在任何 WebView 实例创建之前调用（调试期可改成 true 用 chrome://inspect）
        WebView.setWebContentsDebuggingEnabled(false)
        setupWindow()
        root = FrameLayout(this)
        root.setBackgroundColor(bgColor)
        setContentView(root)

        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            readInsets(insets)
            trackIme(insets)
            insets
        }

        showLoadingOverlay()
        val major = chromiumMajor()
        if (major in 1..93) {
            // 旧内核：DSH 的 bundle 用了 static 初始化块 / ??= 之类语法，
            // 低于 Chromium 94 直接白屏，先给明确提示而不是让用户对着白屏。
            showKernelOverlay(major)
            return
        }
        safeCreateWebView()
        loadTarget()
        maybeAskNotificationPermission()
    }

    /* ---------------------------- 窗口 / 沉浸式 ---------------------------- */

    private fun setupWindow() {
        window.setBackgroundDrawable(ColorDrawable(bgColor))
        // 关键：保持「decor 参与系统窗口布局」（默认行为）。
        // 软键盘弹出时由系统直接把窗口内容区缩小（adjustResize），
        // WebView 的 viewport 一次性变矮：
        //   - 不再有我们手动改高度导致的逐帧 reflow（输入卡顿 + 来回闪的根因）
        //   - 不存在「该撑不撑 / 降不下去」和动画延迟
        // 沉浸式是靠 hide(systemBars) 实现的，与这条不冲突。
        WindowCompat.setDecorFitsSystemWindows(window, true)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.hide(WindowInsetsCompat.Type.systemBars())
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // 关掉系统给透明系统栏自动加的对比度底衬（深色页面下会露一条灰白线）
            window.isStatusBarContrastEnforced = false
            window.isNavigationBarContrastEnforced = false
        }
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
    }

    /**
     * 只算「固定在屏幕两端的避让」：刘海高度 + 手势条高度。
     * 键盘高度不参与 —— 那交给系统 resize。
     */
    private fun readInsets(insets: WindowInsetsCompat) {
        val cut = insets.getInsets(WindowInsetsCompat.Type.displayCutout()).top
        val gesture = insets.getInsets(WindowInsetsCompat.Type.systemGestures()).bottom
        val nav = insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom
        val newTop = cut
        val newBottom = maxOf(gesture, nav)
        if (newTop == safeTop && newBottom == safeBottom) return
        safeTop = newTop
        safeBottom = newBottom
        applyStaticInsets()
    }

    /**
     * 极少数 ROM 在「隐藏系统栏 + adjustResize」时不会真的缩小窗口，
     * 表现就是「该撑起来不撑起来」。这里在键盘稳定后校验一次：
     * 如果窗口高度没有随键盘变小，就由我们自己给 WebView 让出这块高度。
     */
    private fun trackIme(insets: WindowInsetsCompat) {
        val h = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
        if (h == imeH) return
        imeH = h
        handler.removeCallbacks(imeFallback)
        handler.postDelayed(imeFallback, 280)
    }

    private val imeFallback = Runnable {
        val wv = webView ?: return@Runnable
        val lp = wv.layoutParams as? FrameLayout.LayoutParams ?: return@Runnable
        if (imeH <= 0) {
            if (imeFallbackApplied) {
                imeFallbackApplied = false
                lp.bottomMargin = safeBottom
                wv.layoutParams = lp
            }
            return@Runnable
        }
        val screenH = resources.displayMetrics.heightPixels
        val shrunk = screenH - root.height
        if (shrunk < imeH / 2) {
            // 窗口没缩 → 自己补
            imeFallbackApplied = true
            val target = maxOf(safeBottom, imeH)
            if (lp.bottomMargin != target) {
                lp.bottomMargin = target
                wv.layoutParams = lp
            }
        }
    }

    private fun applyStaticInsets() {
        val wv = webView ?: return
        val lp = wv.layoutParams as? FrameLayout.LayoutParams ?: return
        if (lp.topMargin != safeTop || lp.bottomMargin != safeBottom) {
            lp.topMargin = safeTop
            lp.bottomMargin = safeBottom
            wv.layoutParams = lp
        }
        hotspot?.let { spot ->
            val hlp = spot.layoutParams as? FrameLayout.LayoutParams ?: return@let
            if (hlp.height != safeTop) {
                hlp.height = safeTop
                spot.layoutParams = hlp
                spot.visibility = if (safeTop > 0) View.VISIBLE else View.GONE
            }
        }
    }

    /* ---------------------------- WebView ---------------------------- */

    private fun chromiumMajor(): Int {
        return try {
            val ua = WebSettings.getDefaultUserAgent(this)
            Regex("Chrome/(\\d+)").find(ua)?.groupValues?.getOrNull(1)?.toIntOrNull() ?: 0
        } catch (e: Exception) {
            0
        }
    }

    private fun safeCreateWebView() {
        try {
            createWebView()
        } catch (t: Throwable) {
            Log.e(TAG, "WebView unavailable: ${t.message}")
            hideLoadingOverlay()
            removeCard()
            val card = buildCard(getString(R.string.webview_missing), null, emptyList())
            errorOverlay = card
            root.addView(
                card,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
            )
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView() {
        val wv = WebView(this)
        wv.layoutParams = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        )
        wv.setBackgroundColor(bgColor)
        wv.overScrollMode = View.OVER_SCROLL_NEVER
        wv.isHorizontalScrollBarEnabled = false
        wv.scrollBarStyle = View.SCROLLBARS_INSIDE_OVERLAY
        wv.isVerticalScrollBarEnabled = true

        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            useWideViewPort = true
            loadWithOverviewMode = false
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            // 固定文本缩放：系统字号放大不会让页面按 1.3x 重排（那是移动端卡顿/错位的常见来源）
            textZoom = 100
            mediaPlaybackRequiresUserGesture = false
            javaScriptCanOpenWindowsAutomatically = true
            cacheMode = WebSettings.LOAD_DEFAULT
            allowFileAccess = false
            allowContentAccess = false
            setGeolocationEnabled(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            setSupportMultipleWindows(false)
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // 后台也保持渲染进程优先级：agent 在跑的时候页面要能持续收流式数据
            wv.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        }

        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(wv, true)

        wv.addJavascriptInterface(WebBridge(), "DSHPocket")

        wv.webViewClient = object : WebViewClient() {
            override fun onPageCommitVisible(view: WebView, url: String) {
                hideLoadingOverlay()
            }

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                mainFrameError = false
            }

            override fun onPageFinished(view: WebView, url: String) {
                hideLoadingOverlay()
                // 主文档加载失败时 onPageFinished 同样会回调，别把错误提示一起收掉
                if (!mainFrameError) hideErrorOverlay()
                injectFallback(view)
                prefs.lastHost = Uri.parse(prefs.baseUrl).host ?: ""
                CookieManager.getInstance().flush()
            }

            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest
            ): Boolean = handleExternal(request.url)

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: android.webkit.WebResourceError
            ) {
                if (request.isForMainFrame) {
                    mainFrameError = true
                    showErrorOverlay(error.description?.toString())
                }
            }

            override fun onRenderProcessGone(
                view: WebView,
                detail: RenderProcessGoneDetail
            ): Boolean {
                Log.w(TAG, "renderer gone, crashed=${detail.didCrash()}")
                recoverWebView()
                return true
            }
        }

        wv.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                if (newProgress >= 90) hideLoadingOverlay()
            }
        }

        wv.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            startDownload(url, userAgent, contentDisposition, mimeType)
        }

        webView = wv
        root.addView(wv, 0)
        applyStaticInsets()
        injectDocumentStart(wv)
        addTopHotspot()
    }

    private fun injectDocumentStart(wv: WebView) {
        val js = readAsset("inject.js")
        if (js.isBlank()) return
        try {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                // document-start 注入：能赶在页面脚本之前 hook WebSocket
                WebViewCompat.addDocumentStartJavaScript(wv, js, setOf("*"))
                docStartOk = true
            }
        } catch (e: Exception) {
            Log.w(TAG, "doc-start inject failed: ${e.message}")
        }
    }

    /** 老内核（不支持 document-start）兜底：页面加载完再注入一次，脚本自身幂等。 */
    private fun injectFallback(wv: WebView) {
        if (docStartOk) return   // 已经由 document-start 注入过，别再解析一遍 13KB
        val js = readAsset("inject.js")
        if (js.isBlank()) return
        try {
            wv.evaluateJavascript(js, null)
        } catch (e: Exception) {
            Log.w(TAG, "fallback inject failed: ${e.message}")
        }
    }

    private fun recoverWebView() {
        val old = webView
        webView = null
        try {
            root.removeView(old)
            old?.destroy()
        } catch (e: Exception) {
            Log.w(TAG, "destroy failed: ${e.message}")
        }
        showLoadingOverlay()
        safeCreateWebView()
        loadTarget()
    }

    /* ---------------------------- 加载 ---------------------------- */

    private fun loadTarget() {
        val base = prefs.baseUrl.trim().trimEnd('/')
        if (base.isEmpty()) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }
        val pin = prefs.pin.trim()
        val url = if (pin.isEmpty()) {
            base
        } else {
            val sep = if (base.contains('?')) "&" else "?"
            base + sep + "token=" + Uri.encode(pin)
        }
        try {
            webView?.loadUrl(url)
        } catch (e: Exception) {
            showErrorOverlay(e.message)
        }
    }

    /**
     * 只有和配置地址同 host 的导航留在壳里，其余交给系统浏览器，
     * 并且剥掉 token 参数，避免访问密码被带到第三方站点。
     */
    private fun handleExternal(url: Uri): Boolean {
        val scheme = url.scheme?.lowercase() ?: return false
        if (scheme == "about" || scheme == "blob" || scheme == "data" || scheme == "javascript") {
            return false
        }
        val host = url.host
        val mine = Uri.parse(prefs.baseUrl).host
        if (host == null || mine == null || host.equals(mine, ignoreCase = true)) return false

        val builder = url.buildUpon().clearQuery()
        runCatching {
            url.queryParameterNames.forEach { name ->
                if (name != "token" && name != "pin" && name != "password") {
                    builder.appendQueryParameter(name, url.getQueryParameter(name))
                }
            }
        }
        try {
            startActivity(Intent(Intent.ACTION_VIEW, builder.build()))
        } catch (e: Exception) {
            Log.w(TAG, "no browser: ${e.message}")
        }
        return true
    }

    private fun startDownload(url: String, ua: String, disposition: String, mime: String) {
        if (!url.startsWith("http")) return
        try {
            val name = URLUtil.guessFileName(url, disposition, mime)
            val req = DownloadManager.Request(Uri.parse(url)).apply {
                setMimeType(mime)
                addRequestHeader("User-Agent", ua)
                CookieManager.getInstance().getCookie(url)?.let {
                    addRequestHeader("Cookie", it)
                }
                setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED
                )
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
            }
            (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(req)
            Toast.makeText(this, "开始下载 $name", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Log.w(TAG, "download failed: ${e.message}")
            Toast.makeText(this, "下载失败", Toast.LENGTH_SHORT).show()
        }
    }

    /* ---------------------------- 遮罩层 ---------------------------- */

    private fun showLoadingOverlay() {
        if (loadingOverlay != null) return
        val box = FrameLayout(this)
        box.setBackgroundColor(bgColor)
        val img = ImageView(this)
        img.setImageResource(R.drawable.ic_whale)
        img.imageTintList = ColorStateList.valueOf(
            ContextCompat.getColor(this, R.color.text_secondary)
        )
        img.alpha = 0.35f
        box.addView(
            img,
            FrameLayout.LayoutParams(dp(40), dp(40), Gravity.CENTER)
        )
        loadingOverlay = box
        root.addView(
            box,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
    }

    private fun hideLoadingOverlay() {
        val box = loadingOverlay ?: return
        loadingOverlay = null
        box.animate().alpha(0f).setDuration(OVERLAY_FADE_MS).withEndAction {
            runCatching { root.removeView(box) }
        }.start()
    }

    private fun showErrorOverlay(detail: String?) {
        hideLoadingOverlay()
        removeCard()
        val body = (detail ?: "").ifBlank {
            "请确认电脑上的 dsh web 正在运行，并且手机和电脑在同一个网络。"
        }
        val card = buildCard(
            "连不上这个地址",
            body,
            listOf(
                "检查地址" to {
                    startActivity(Intent(this, SetupActivity::class.java))
                }
            )
        )
        errorOverlay = card
        root.addView(
            card,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
    }

    /** 内核太旧（Chromium < 94）：DSH 前端用到的语法/API 不支持，会白屏或明显卡顿。 */
    private fun showKernelOverlay(major: Int) {
        hideLoadingOverlay()
        removeCard()
        val card = buildCard(
            getString(R.string.kernel_old_title),
            getString(R.string.kernel_old_body, major),
            listOf(
                getString(R.string.kernel_old_retry) to { recreate() },
                getString(R.string.kernel_old_continue) to {
                    removeCard()
                    safeCreateWebView()
                    loadTarget()
                    maybeAskNotificationPermission()
                }
            )
        )
        errorOverlay = card
        root.addView(
            card,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
    }

    private fun buildCard(title: String, body: String?, actions: List<Pair<String, () -> Unit>>): View {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(bgColor)
            setPadding(dp(28), dp(28), dp(28), dp(28))
        }
        box.addView(TextView(this).apply {
            text = title
            setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text_primary))
            textSize = 18f
            gravity = Gravity.CENTER
        })
        if (!body.isNullOrBlank()) {
            box.addView(TextView(this).apply {
                text = body
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text_secondary))
                textSize = 13f
                gravity = Gravity.CENTER
                setPadding(dp(6), dp(14), dp(6), 0)
                setLineSpacing(0f, 1.25f)
            })
        }
        actions.forEach { (label, action) ->
            box.addView(TextView(this).apply {
                text = label
                setTextColor(Color.WHITE)
                textSize = 15f
                gravity = Gravity.CENTER
                background = ContextCompat.getDrawable(this@MainActivity, R.drawable.bg_button)
                setPadding(dp(26), dp(12), dp(26), dp(12))
                setOnClickListener { runCatching { action() } }
            }, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(14) })
        }
        return box
    }

    private fun removeCard() {
        val box = errorOverlay ?: return
        errorOverlay = null
        runCatching { root.removeView(box) }
    }

    private fun hideErrorOverlay() = removeCard()

    /* ---------------------------- 顶部隐藏入口 ---------------------------- */

    /**
     * 顶部安全区（刘海/状态栏那一条，页面内容不会覆盖到）双击 → 重新配置地址。
     * 常驻 UI 里不加任何按钮，入口藏在这里。
     */
    private fun addTopHotspot() {
        if (hotspot != null) return
        val spot = View(this)
        val lp = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, safeTop)
        spot.visibility = if (safeTop > 0) View.VISIBLE else View.GONE
        spot.setOnClickListener(object : View.OnClickListener {
            private var last = 0L
            override fun onClick(v: View?) {
                val now = SystemClock.uptimeMillis()
                if (now - last < 600) {
                    last = 0
                    startActivity(Intent(this@MainActivity, SetupActivity::class.java))
                } else {
                    last = now
                }
            }
        })
        hotspot = spot
        root.addView(spot, lp)
    }

    /* ---------------------------- 通知 ---------------------------- */

    private fun maybeAskNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (Notifier.hasPermission(this)) return
        handler.postDelayed({
            if (isFinishing || isDestroyed) return@postDelayed
            runCatching {
                requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIF)
            }
        }, 2600)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_NOTIF && grantResults.firstOrNull() == 0) {
            Notifier.ensureChannel(this)
        }
    }

    /* ---------------------------- 生命周期 ---------------------------- */

    inner class WebBridge {
        @JavascriptInterface
        fun setBackground(css: String?) {
            val color = parseCssColor(css ?: return) ?: return
            if (color == bgColor) return
            bgColor = color
            prefs.lastBg = color
            handler.post {
                window.setBackgroundDrawable(ColorDrawable(color))
                root.setBackgroundColor(color)
                webView?.setBackgroundColor(color)
                loadingOverlay?.setBackgroundColor(color)
                errorOverlay?.setBackgroundColor(color)
            }
        }

        @JavascriptInterface
        fun onTurnEnd(title: String?) {
            if (resumed) return // 用户正看着页面，不用通知
            val detail = title?.trim().orEmpty()
            handler.post {
                Notifier.notifyTurnDone(this@MainActivity, detail)
            }
        }

        @JavascriptInterface
        fun savePin(pin: String?) {
            val v = pin?.trim().orEmpty()
            if (v.isEmpty() || v.length > 128) return
            if (v == prefs.pin) return
            prefs.pin = v
        }

        @JavascriptInterface
        fun smoothMode(): Boolean = prefs.smooth

        @JavascriptInterface
        fun log(msg: String?) {
            Log.d(TAG, "js: ${msg ?: ""}")
        }
    }

    private fun parseCssColor(css: String): Int? {
        val s = css.trim()
        return try {
            when {
                s.startsWith("#") -> Color.parseColor(s)
                s.startsWith("rgb") -> {
                    val nums = s.substringAfter('(').substringBefore(')')
                        .split(',').map { it.trim() }
                    if (nums.size < 3) return null
                    val r = nums[0].toFloat().toInt()
                    val g = nums[1].toFloat().toInt()
                    val b = nums[2].toFloat().toInt()
                    val a = if (nums.size >= 4) (nums[3].toFloat() * 255).toInt() else 255
                    Color.argb(a.coerceIn(0, 255), r, g, b)
                }
                else -> null
            }
        } catch (e: Exception) {
            null
        }
    }

    private fun readAsset(name: String): String {
        return try {
            assets.open(name).use { input ->
                BufferedReader(input.reader()).readText()
            }
        } catch (e: Exception) {
            Log.w(TAG, "asset $name: ${e.message}")
            ""
        }
    }

    private fun dp(v: Int): Int =
        (v * resources.displayMetrics.density).toInt()

    override fun onResume() {
        super.onResume()
        resumed = true
        if (!prefs.configured) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
        }
    }

    override fun onPause() {
        resumed = false
        runCatching { CookieManager.getInstance().flush() }
        super.onPause()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus) return
        // 只在系统栏确实可见时才重新隐藏：无脑每次 hide 会触发一次 insets 变化，
        // 表现就是「点一下输入框，页面闪一下」。
        val insets = ViewCompat.getRootWindowInsets(root) ?: return
        val barsVisible = insets.isVisible(WindowInsetsCompat.Type.statusBars()) ||
            insets.isVisible(WindowInsetsCompat.Type.navigationBars())
        if (barsVisible) {
            WindowInsetsControllerCompat(window, window.decorView).apply {
                hide(WindowInsetsCompat.Type.systemBars())
                systemBarsBehavior =
                    WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.getBooleanExtra(EXTRA_RELOAD, false) && prefs.configured) {
            hideErrorOverlay()
            showLoadingOverlay()
            loadTarget()
        }
    }

    override fun onBackPressed() {
        val wv = webView
        if (wv != null && wv.canGoBack()) {
            wv.goBack()
            return
        }
        val now = SystemClock.uptimeMillis()
        if (now - lastBackAt < 2000) {
            super.onBackPressed()
            return
        }
        lastBackAt = now
        Toast.makeText(this, R.string.back_again_exit, Toast.LENGTH_SHORT).show()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        val wv = webView
        webView = null
        runCatching {
            root.removeView(wv)
            wv?.stopLoading()
            wv?.destroy()
        }
        super.onDestroy()
    }
}
