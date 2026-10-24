package com.hiweny.dshpocket

import android.net.Uri

/**
 * 地址 / 二维码内容解析。
 *
 * dsh-pocket 的二维码内容就是局域网或公网入口地址（形如 http://192.168.1.10:3081），
 * 密码单独显示在电脑上；同时也兼容：
 *   - 带 token 的链接：http://ip:3081/?token=xxxxxxxx
 *   - 只有 host:port：192.168.1.10:3081
 *   - JSON：{"url":"http://…","token":"…"}
 */
object Pairing {

    data class Result(
        val base: String?,
        val pin: String? = null,
        val error: String? = null
    )

    private val HOST_ONLY = Regex("^[\\w.\\-]+(:\\d+)?$")

    fun parse(raw: String?): Result {
        val text = (raw ?: "").trim().trim('"', '\'', ' ')
        if (text.isEmpty()) return Result(null, error = "empty")

        // JSON 形态
        if (text.startsWith("{")) {
            val url = field(text, "url") ?: field(text, "base") ?: field(text, "address")
            val host = field(text, "host") ?: field(text, "ip")
            val port = field(text, "port")
            val pin = field(text, "token") ?: field(text, "pin") ?: field(text, "password")
            val base = when {
                !url.isNullOrBlank() -> normalize(url)
                !host.isNullOrBlank() -> "http://$host" + if (port.isNullOrBlank()) ":3081" else ":$port"
                else -> null
            }
            if (base != null) return Result(base, pin)
        }

        if (text.startsWith("http://") || text.startsWith("https://")) {
            val uri = runCatching { Uri.parse(text) }.getOrNull()
            val host = uri?.host
            if (uri != null && !host.isNullOrBlank()) {
                val scheme = uri.scheme ?: "http"
                val portPart = if (uri.port > 0) ":${uri.port}" else ""
                val path = uri.path?.let { if (it == "/") "" else it } ?: ""
                val pin = uri.getQueryParameter("token")
                    ?: uri.getQueryParameter("pin")
                    ?: uri.getQueryParameter("password")
                return Result("$scheme://$host$portPart$path", pin)
            }
        }

        // host:port / host:port/pin
        val head = text.split(Regex("[\\s,;|]+"), limit = 2)
        val addr = head[0]
        val trailing = head.getOrNull(1)?.trim()
        val slash = addr.indexOf('/')
        val addrNoPath = if (slash > 0) addr.substring(0, slash) else addr
        val pinFromPath = if (slash > 0) addr.substring(slash + 1).trim().ifBlank { null } else null
        if (HOST_ONLY.matches(addrNoPath)) {
            val base = "http://" + if (addrNoPath.contains(':')) addrNoPath else "$addrNoPath:3081"
            return Result(base, trailing ?: pinFromPath)
        }

        if (text.contains('.') || text.contains(':')) {
            return Result(normalize(text), null)
        }
        return Result(null, error = "unrecognized")
    }

    private fun normalize(url: String): String {
        val t = url.trim().trimEnd('/')
        return if (t.startsWith("http://") || t.startsWith("https://")) t else "http://$t"
    }

    private fun field(json: String, key: String): String? {
        val m = Regex("\"$key\"\\s*:\\s*\"([^\"]*)\"").find(json)
        return m?.groupValues?.getOrNull(1)
    }
}
