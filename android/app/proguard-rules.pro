# WebView JavaScript bridge 方法通过 @JavascriptInterface 暴露，不需要额外规则。
-keepclassmembers class com.hiweny.dshpocket.MainActivity$WebBridge {
    public *;
}
-keep class com.journeyapps.barcodescanner.** { *; }
-keep class com.google.zxing.** { *; }
