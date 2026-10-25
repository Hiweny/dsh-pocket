package com.hiweny.dshpocket

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.ImageView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowCompat.setDecorFitsSystemWindows
import androidx.core.view.WindowInsetsCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

/**
 * 首次进入 / 重新配置：填地址（或扫码）+ 访问密码。
 * 密码会记住（Keystore 加密），下次打开走 `?token=` 直接进。
 */
class SetupActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs
    private lateinit var urlInput: EditText
    private lateinit var pinInput: EditText
    private lateinit var errorText: TextView

    private val cameraPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) openScanner()
            else toast(getString(R.string.scan_permission))
        }

    private val scanLauncher = registerForActivityResult(ScanContract()) { result ->
        val contents = result?.contents
        if (contents.isNullOrBlank()) return@registerForActivityResult
        applyScanned(contents)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_setup)

        val rootView = findViewById<ViewGroup>(R.id.setup_root)
        ViewCompat.setOnApplyWindowInsetsListener(rootView) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            insets
        }

        urlInput = findViewById(R.id.url_input)
        pinInput = findViewById(R.id.pin_input)
        errorText = findViewById(R.id.error_text)

        if (prefs.baseUrl.isNotBlank()) urlInput.setText(prefs.baseUrl)
        val savedPin = prefs.pin
        if (savedPin.isNotBlank()) pinInput.setText(savedPin)

        val smoothSwitch = findViewById<androidx.appcompat.widget.SwitchCompat>(R.id.smooth_switch)
        smoothSwitch.isChecked = prefs.smooth
        smoothSwitch.setOnCheckedChangeListener { _, checked -> prefs.smooth = checked }

        findViewById<ImageView>(R.id.scan_btn).setOnClickListener { requestScan() }
        findViewById<TextView>(R.id.enter_btn).setOnClickListener { submit() }
        pinInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE) {
                submit()
                true
            } else {
                false
            }
        }
        findViewById<TextView>(R.id.kernel_info).text =
            "WebView Chromium ${webViewMajor()} · App v${BuildConfig.VERSION_NAME}"
        urlInput.requestFocus()
    }

    private fun webViewMajor(): String {
        return try {
            val ua = android.webkit.WebSettings.getDefaultUserAgent(this)
            Regex("Chrome/(\\d+)").find(ua)?.groupValues?.getOrNull(1) ?: "未知"
        } catch (e: Exception) {
            "未知"
        }
    }

    private fun requestScan() {
        val granted = ContextCompat.checkSelfPermission(
            this, Manifest.permission.CAMERA
        ) == PackageManager.PERMISSION_GRANTED
        if (granted) openScanner() else cameraPermission.launch(Manifest.permission.CAMERA)
    }

    private fun openScanner() {
        val options = ScanOptions().apply {
            setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            setPrompt(getString(R.string.setup_scan_hint))
            setBeepEnabled(false)
            setOrientationLocked(false)
            setBarcodeImageEnabled(false)
            setCaptureActivity(ScanActivity::class.java)
        }
        runCatching { scanLauncher.launch(options) }
            .onFailure { toast("没有可用的相机") }
    }

    private fun applyScanned(raw: String) {
        val parsed = Pairing.parse(raw)
        if (parsed.base.isNullOrBlank()) {
            showError(getString(R.string.setup_err_url))
            return
        }
        urlInput.setText(parsed.base)
        if (!parsed.pin.isNullOrBlank()) {
            pinInput.setText(parsed.pin)
        }
        urlInput.setSelection(urlInput.text.length)
        hideError()
    }

    private fun submit() {
        val typed = urlInput.text?.toString().orEmpty().trim()
        if (typed.isEmpty()) {
            showError(getString(R.string.setup_err_empty))
            return
        }
        val parsed = Pairing.parse(typed)
        val base = parsed.base
        if (base.isNullOrBlank()) {
            showError(getString(R.string.setup_err_url))
            return
        }
        prefs.baseUrl = base

        val typedPin = pinInput.text?.toString().orEmpty().trim()
        val pin = typedPin.ifBlank { parsed.pin.orEmpty() }
        if (pin.isNotEmpty()) prefs.pin = pin else prefs.resetPin()

        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(MainActivity.EXTRA_RELOAD, true)
        }
        startActivity(intent)
        finish()
    }

    private fun showError(msg: String) {
        errorText.text = msg
        errorText.visibility = View.VISIBLE
    }

    private fun hideError() {
        errorText.visibility = View.GONE
    }

    private fun toast(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    }
}
