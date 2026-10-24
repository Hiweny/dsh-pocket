#!/usr/bin/env bash
# 模拟器冒烟：装 APK → 填地址进页面 → 截图 → 弹键盘 → 截图 → 分析像素
set -uo pipefail

APK="${1:-app-debug.apk}"
PKG="com.hiweny.dshpocket.debug"
OUT=/tmp/shots
mkdir -p "$OUT"

echo "== wait device"
adb wait-for-device
adb shell getprop sys.boot_completed | tr -d '\r'
for i in $(seq 1 30); do
  b=$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
  [ "$b" = "1" ] && break
  sleep 2
done

adb shell settings put global window_animation_scale 0.0 || true
adb shell settings put global transition_animation_scale 0.0 || true
adb shell settings put global animator_duration_scale 0.0 || true
adb shell svc power stayon true || true

echo "== install"
adb install -r "$APK"
adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS || true
adb shell pm grant "$PKG" android.permission.CAMERA || true

echo "== serve test page"
( cd .github/smoke && nohup python3 -m http.server 8099 > /tmp/http.log 2>&1 & )
sleep 2
adb reverse tcp:8099 tcp:8099
curl -s -o /dev/null -w "host page: %{http_code}\n" http://127.0.0.1:8099/ || true

SIZE=$(adb shell wm size | tr -d '\r' | awk '{print $3}')
W=${SIZE%x*}
H=${SIZE#*x}
echo "== screen $W x $H"

echo "== launch"
adb shell am force-stop "$PKG"
adb shell am start -n "$PKG/com.hiweny.dshpocket.MainActivity" > /dev/null
sleep 4
adb exec-out screencap -p > "$OUT/01-setup.png"

echo "== type url"
adb shell input text "127.0.0.1:8099"
sleep 1
adb shell input keyevent 66
sleep 1
adb shell input keyevent 66
sleep 7
adb exec-out screencap -p > "$OUT/02-page.png"

echo "== keyboard"
adb shell input tap $((W / 2)) $((H - 90))
sleep 1
adb shell input tap $((W / 2)) $((H - 60))
sleep 3
adb shell dumpsys input_method | grep -o "mInputShown=[a-z]*" | head -2 || true
adb exec-out screencap -p > "$OUT/03-ime.png"

echo "== scroll up (check overscroll / edge color)"
adb shell input swipe $((W / 2)) $((H / 3)) $((W / 2)) $((H / 2)) 300
sleep 1
adb exec-out screencap -p > "$OUT/04-scroll.png"

echo "== back"
adb shell input keyevent 4
sleep 1
adb exec-out screencap -p > "$OUT/05-back.png"

echo "== logcat (app)"
adb logcat -d -s DSHPocket:* AndroidRuntime:E chromium:E | tail -40 || true

python3 .github/scripts/analyze.py "$OUT"/*.png || true
ls -lh "$OUT"
