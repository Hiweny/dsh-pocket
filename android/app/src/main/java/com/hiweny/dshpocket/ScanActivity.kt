package com.hiweny.dshpocket

import com.journeyapps.barcodescanner.CaptureActivity

/**
 * 扫码页：直接复用 zxing-android-embedded 的取景界面。
 * 单独声明一个子类，是为了在 AndroidManifest 里指定不锁定方向 + 深色主题。
 */
class ScanActivity : CaptureActivity()
