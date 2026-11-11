#!/usr/bin/env bash
# Install (or remove) a macOS launchd job that runs `apply --email` weekly.
#
#   scripts/install-schedule.sh               # Saturdays 08:00
#   WEEKDAY=5 HOUR=7 scripts/install-schedule.sh   # Fridays 07:00 (0 = Sunday … 6 = Saturday)
#   scripts/install-schedule.sh --uninstall
#
# If the Mac is asleep at that time, launchd runs the job once it wakes.
# Output goes to ~/.dietly-autopilot/weekly.log.
set -euo pipefail

LABEL=com.dietly-autopilot.weekly
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "$PLIST"
  echo "Removed $LABEL."
  exit 0
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(node -p process.execPath)"
GWS="$(command -v gws || true)"
[[ -n "$GWS" ]] || { echo "gws not found on PATH — needed to send the summary email." >&2; exit 1; }
LOG_DIR="$HOME/.dietly-autopilot"
mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"

cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>src/cli.ts</string>
    <string>apply</string>
    <string>--email</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$GWS"):$(dirname "$NODE"):/usr/bin:/bin</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key><integer>${WEEKDAY:-6}</integer>
    <key>Hour</key><integer>${HOUR:-8}</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key><string>$LOG_DIR/weekly.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/weekly.log</string>
</dict>
</plist>
PLIST

launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Installed $LABEL: weekday ${WEEKDAY:-6} at ${HOUR:-8}:00, running $REPO with $NODE."
echo "Run it now with: launchctl kickstart $DOMAIN/$LABEL"
