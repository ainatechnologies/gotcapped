#!/bin/bash
# Screenshot the REAL app window under Xvfb with the synthetic fixture home. Usage: shoot.sh <view|onboarding> <out.png>
set -e; cd "$(dirname "$0")/.."
node fixtures/make-home.mjs /tmp/gc-shot-home >/dev/null
export DISPLAY=:77 GC_FIXTURE_HOME=/tmp/gc-shot-home GC_SHOW=1 GC_KEEP_OPEN=1 XDG_CONFIG_HOME=/tmp/gc-shot-cfg
rm -rf /tmp/gc-shot-cfg
if [ "$1" = onboarding ]; then export GC_FIXTURE_ONBOARDED=0; else export GC_FIXTURE_ONBOARDED=1 GC_VIEW="$1"; fi
[ "$1" = home ] && unset GC_VIEW
src-tauri/target/release/gotcapped-tray & P=$!
sleep ${WAIT:-7}
python3 - "$2" <<'PY'
import sys,subprocess
from PIL import ImageGrab
wid=subprocess.check_output(["xdotool","search","--name","Got Capped"]).split()[-1].decode()
g=dict(l.split("=") for l in subprocess.check_output(["xdotool","getwindowgeometry","--shell",wid]).decode().split())
x,y,w,h=int(g["X"]),int(g["Y"]),int(g["WIDTH"]),int(g["HEIGHT"])
ImageGrab.grab(bbox=(x,y,x+w,y+h),xdisplay=":77").save(sys.argv[1])
PY
kill $P
