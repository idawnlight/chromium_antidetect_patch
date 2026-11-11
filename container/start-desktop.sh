#!/usr/bin/env bash
set -euo pipefail

mkdir -p "$XDG_RUNTIME_DIR" "$HOME/.config/openbox" "$HOME/.config/pulse"
chmod 700 "$XDG_RUNTIME_DIR"

if [[ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]]; then
  exec dbus-run-session -- "$0" "$@"
fi

desktop_jobs=()
cleanup() {
  for desktop_pid in "${desktop_jobs[@]}"; do
    kill "$desktop_pid" 2>/dev/null || true
  done
  pulseaudio --kill 2>/dev/null || true
}
trap cleanup EXIT

panel_bottom="${DESKTOP_PANEL_HEIGHT:-36}"
cat > "$HOME/.config/openbox/rc.xml" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <margins>
    <top>0</top>
    <bottom>${panel_bottom}</bottom>
    <left>0</left>
    <right>0</right>
  </margins>
</openbox_config>
EOF

Xvfb "$DISPLAY" -screen 0 "${DESKTOP_GEOMETRY:-1920x1080x24}" -dpi 96 -nolisten tcp -noreset > /tmp/xvfb.log 2>&1 &
desktop_jobs+=("$!")
for attempt in $(seq 1 50); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
xdpyinfo -display "$DISPLAY" >/dev/null

printf 'Xft.dpi: 96\nXft.antialias: 1\nXft.hinting: 1\nXft.hintstyle: hintslight\nXft.rgba: rgb\n' | xrdb -merge
openbox --sm-disable > /tmp/openbox.log 2>&1 &
desktop_jobs+=("$!")
for attempt in $(seq 1 30); do
  if xprop -root -display "$DISPLAY" _NET_WORKAREA 2>/dev/null | grep -q '_NET_WORKAREA'; then break; fi
  sleep 0.1
done

printf 'default-sample-rate = 48000\nalternate-sample-rate = 48000\n' > "$HOME/.config/pulse/daemon.conf"
pulseaudio --start --exit-idle-time=-1 --log-target=file:/tmp/pulseaudio.log
pactl load-module module-null-sink sink_name=desktop_output rate=48000 channels=2 \
  sink_properties=device.description=Built-in_Audio_Analog_Stereo > /tmp/audio-sink.txt
pactl set-default-sink desktop_output
pactl load-module module-remap-source master=desktop_output.monitor source_name=desktop_mic rate=48000 channels=2 \
  source_properties=device.description=Built-in_Microphone > /tmp/audio-source.txt
pactl set-default-source desktop_mic

# Use Mesa software OpenGL when no hardware render node is mounted into /dev/dri.
if [[ ! -e /dev/dri/renderD128 && -z "${LIBGL_ALWAYS_SOFTWARE:-}" ]]; then
  export LIBGL_ALWAYS_SOFTWARE=1
fi

export PROBE_DISPLAY="$DISPLAY"
export PROBE_LANG="${PROBE_LANG:-en-US}"
export PROBE_LANGUAGES="${PROBE_LANGUAGES:-en-US,en}"
exec "$@"
