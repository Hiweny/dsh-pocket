package com.hiweny.dshpocket

import android.content.Context
import android.content.SharedPreferences

/**
 * 本机配置：访问地址 / 访问密码（Keystore 加密）/ 上次页面底色。
 * 密码只存在应用私有目录，且用 Android Keystore 里的 AES-GCM 密钥加密。
 */
class Prefs(context: Context) {

    private val sp: SharedPreferences =
        context.applicationContext.getSharedPreferences("dshpocket", Context.MODE_PRIVATE)

    var baseUrl: String
        get() = sp.getString(KEY_URL, "").orEmpty()
        set(value) = sp.edit().putString(KEY_URL, value).apply()

    /** 加密后的密码串（iv:ct，base64）。 */
    private var pinSealed: String
        get() = sp.getString(KEY_PIN, "").orEmpty()
        set(value) = sp.edit().putString(KEY_PIN, value).apply()

    var pin: String
        get() = SecretBox.open(pinSealed)
        set(value) = run { pinSealed = SecretBox.seal(value) }

    /** 上次页面实际背景色（ARGB），用于冷启动时消除白闪。 */
    var lastBg: Int
        get() = sp.getInt(KEY_BG, 0)
        set(value) = sp.edit().putInt(KEY_BG, value).apply()

    /** 上一次已知的页面地址（host），用于判断内部/外链。 */
    var lastHost: String
        get() = sp.getString(KEY_HOST, "").orEmpty()
        set(value) = sp.edit().putString(KEY_HOST, value).apply()

    val configured: Boolean
        get() = baseUrl.isNotBlank()

    fun resetPin() {
        pinSealed = ""
    }

    companion object {
        private const val KEY_URL = "base_url"
        private const val KEY_PIN = "pin_sealed"
        private const val KEY_BG = "last_bg"
        private const val KEY_HOST = "last_host"
    }
}
