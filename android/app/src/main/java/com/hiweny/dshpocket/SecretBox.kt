package com.hiweny.dshpocket

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/**
 * 用 Android Keystore 里的 AES-256-GCM 密钥封装访问密码。
 *
 * 只做「静态存储加密」：密钥不可导出，密文被拷走也无法在别的设备解密。
 */
object SecretBox {

    private const val TAG = "DSHPocket"
    private const val ALIAS = "dshpocket_secret_v1"
    private const val KEYSTORE = "AndroidKeyStore"
    private const val TRANSFORM = "AES/GCM/NoPadding"

    private fun keyStore(): KeyStore =
        KeyStore.getInstance(KEYSTORE).apply { load(null) }

    private fun key(): SecretKey? {
        return try {
            val ks = keyStore()
            (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.secretKey ?: run {
                val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
                gen.init(
                    KeyGenParameterSpec.Builder(
                        ALIAS,
                        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
                    )
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .setKeySize(256)
                        .build()
                )
                gen.generateKey()
            }
        } catch (e: Exception) {
            Log.w(TAG, "keystore unavailable: ${e.message}")
            null
        }
    }

    fun seal(plain: String): String {
        if (plain.isEmpty()) return ""
        return try {
            val key = key() ?: return ""
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.ENCRYPT_MODE, key)
            val iv = cipher.iv
            val ct = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
            Base64.encodeToString(iv, Base64.NO_WRAP) + ":" +
                Base64.encodeToString(ct, Base64.NO_WRAP)
        } catch (e: Exception) {
            Log.w(TAG, "seal failed: ${e.message}")
            ""
        }
    }

    fun open(sealed: String): String {
        if (sealed.isEmpty() || !sealed.contains(':')) return ""
        return try {
            val key = key() ?: return ""
            val parts = sealed.split(':')
            if (parts.size != 2) return ""
            val iv = Base64.decode(parts[0], Base64.NO_WRAP)
            val ct = Base64.decode(parts[1], Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.DECRYPT_MODE, key, javax.crypto.spec.GCMParameterSpec(128, iv))
            val pt = cipher.doFinal(ct)
            String(pt, Charsets.UTF_8)
        } catch (e: Exception) {
            Log.w(TAG, "open failed: ${e.message}")
            ""
        }
    }
}
