#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
if [[ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]]; then
  exec dbus-run-session -- "$0" "$@"
fi
desktop_jobs=()
cleanup() {
  for desktop_pid in "${desktop_jobs[@]}"; do kill "$desktop_pid" 2>/dev/null || true; done
  pulseaudio --kill 2>/dev/null || true
}
trap cleanup EXIT
Xvfb "$DISPLAY" -screen 0 "${DESKTOP_GEOMETRY:-1920x1080x24}" -dpi 96 -nolisten tcp -noreset > /tmp/xvfb.log 2>&1 &
desktop_jobs+=("$!")
for attempt in $(seq 1 50); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
xdpyinfo -display "$DISPLAY" >/dev/null
printf 'Xft.dpi: 96\nXft.antialias: 1\n' | xrdb -merge
openbox --sm-disable > /tmp/openbox.log 2>&1 &
desktop_jobs+=("$!")
mkdir -p "$HOME/.config/pulse"
printf 'default-sample-rate = 48000\nalternate-sample-rate = 48000\n' > "$HOME/.config/pulse/daemon.conf"
pulseaudio --start --exit-idle-time=-1 --log-target=file:/tmp/pulseaudio.log
pactl load-module module-null-sink sink_name=desktop_output rate=48000 channels=2 sink_properties=device.description=Desktop_Output > /tmp/audio-module.txt
pactl set-default-sink desktop_output
speech-dispatcher -d > /tmp/speech-dispatcher.log 2>&1
export PROBE_DISPLAY="$DISPLAY"
export PROBE_LANG="${PROBE_LANG:-en-US}"
export PROBE_LANGUAGES="${PROBE_LANGUAGES:-en-US,en}"
"$@"
