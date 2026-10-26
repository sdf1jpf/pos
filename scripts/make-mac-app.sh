#!/bin/sh
# Builds a double-clickable POS launcher for macOS, for the Dock, Launchpad
# or Spotlight: it opens a Terminal window and runs the greenscreen
# terminal against the POS.
#
#   scripts/make-mac-app.sh                       # the back office, on the cloud
#   scripts/make-mac-app.sh [api-url]             # or another URL
#   scripts/make-mac-app.sh --register NAME [--no-display] [api-url]
#
# The back office app signs on through Cloudflare Access (cloudflared opens
# the browser the first time). A register app signs on with the register's
# service token instead: set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET
# when you run this, and they are kept inside the app (readable only by
# you). Point a register at its store's server, if the store has one:
#
#   CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=... \
#     scripts/make-mac-app.sh --register "Lane 1" http://store-server:8080
#
# A register app takes the whole Mac: the terminal goes full screen on the
# main monitor and, with a second monitor, the customer display (/display)
# goes full screen on it, in Chrome, Edge or Chromium in kiosk mode. The
# first time, pair the display at the register (PF4, option 12); it stays
# paired. --no-display leaves the customer display out. Full screen needs
# the app allowed in System Settings, Privacy & Security, Accessibility
# (macOS asks the first time).
#
# The window uses the Terminal profile named by PROFILE (default GoTerm),
# or Terminal's default if there is no such profile. Apps go in
# ~/Applications (set DEST to change that). It needs Go, to build the
# terminal. Run it again to rebuild.
set -eu

CLOUD=https://greenscreen-pos.justin-frank.workers.dev
GREENSCREEN=${GREENSCREEN:-v0.2.3} # the terminal's version
PROFILE=${PROFILE:-GoTerm}
DEST=${DEST:-$HOME/Applications}

REGISTER=
DISPLAY_TOO=
if [ "${1:-}" = --register ]; then
	REGISTER=${2:?--register needs a name, e.g. "Lane 1"}
	shift 2
	DISPLAY_TOO=yes
	if [ "${1:-}" = --no-display ]; then
		DISPLAY_TOO=
		shift
	fi
	if [ -z "${CF_ACCESS_CLIENT_ID:-}" ] || [ -z "${CF_ACCESS_CLIENT_SECRET:-}" ]; then
		echo "make-mac-app.sh: a register signs on with its service token: set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET" >&2
		exit 1
	fi
fi
API_URL=${1:-$CLOUD}
if [ -n "$REGISTER" ]; then APP_NAME="POS $REGISTER"; else APP_NAME="POS Back Office"; fi
APP="$DEST/$APP_NAME.app"

if [ "$(uname)" != Darwin ]; then
	echo "make-mac-app.sh: this only works on macOS" >&2
	exit 1
fi
command -v go >/dev/null || { echo "make-mac-app.sh: install Go first (https://go.dev/dl/)" >&2; exit 1; }

mkdir -p "$DEST"
rm -rf "$APP"

# The launcher is a small AppleScript app. It tells Terminal to run the
# script inside the app, then applies the profile and sizes the window. A
# register's goes full screen, after starting its customer display.
if [ -n "$REGISTER" ]; then
	SIZE='try
	tell application "System Events" to tell process "Terminal" to set value of attribute "AXFullScreen" of front window to true
end try'
else
	SIZE='tell application "Terminal"
	set number of columns of front window to 100
	set number of rows of front window to 32
end tell'
fi
if [ -n "$DISPLAY_TOO" ]; then
	DISPLAY_START='do shell script quoted form of (POSIX path of (path to me) & "Contents/Resources/display") & " > /dev/null 2>&1 &"'
else
	DISPLAY_START=
fi
osacompile -o "$APP" <<APPLESCRIPT
set run to quoted form of (POSIX path of (path to me) & "Contents/Resources/run")
$DISPLAY_START
tell application "Terminal"
	activate
	set t to do script run & "; exit"
	try
		set current settings of t to settings set "$PROFILE"
	end try
	delay 0.2
end tell
$SIZE
APPLESCRIPT

RES="$APP/Contents/Resources"
GOBIN="$RES" go install "github.com/sdf1jpf/greenscreen/cmd/greenscreen@$GREENSCREEN"

# run starts the terminal, with the register's token if it has one.
{
	echo '#!/bin/sh'
	echo 'here=$(dirname "$0")'
	if [ -n "$REGISTER" ]; then echo '. "$here/token"; export CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET'; fi
	echo "exec \"\$here/greenscreen\" -api '$API_URL'"
} > "$RES/run"
chmod 755 "$RES/run"
# display opens the customer display full screen on the second monitor,
# in its own browser profile so that it stays paired.
if [ -n "$DISPLAY_TOO" ]; then
	cat > "$RES/display" <<DISPLAY
#!/bin/sh
URL='$API_URL/display'
PROFILE_DIR="\$HOME/Library/Application Support/POS Customer Display/$REGISTER"
for b in "Google Chrome" "Microsoft Edge" Chromium; do
	if [ -d "/Applications/\$b.app" ]; then browser="/Applications/\$b.app"; break; fi
done
# The second monitor's top left, as Chrome counts it (from the top left of
# the main one); nothing with one monitor.
at=\$(osascript -l JavaScript -e '
ObjC.import("AppKit");
const s = \$.NSScreen.screens;
if (s.count < 2) ""; else {
	const main = s.objectAtIndex(0).frame, f = s.objectAtIndex(s.count - 1).frame;
	Math.round(f.origin.x) + "," + Math.round(main.size.height - f.origin.y - f.size.height);
}')
if [ -z "\$at" ]; then
	echo "One monitor: the customer display isn't opened" >&2
	exit 0
fi
if [ -z "\${browser:-}" ]; then
	echo "Install Google Chrome (or Edge) for a full-screen customer display" >&2
	exec open "\$URL"
fi
exec open -na "\$browser" --args --user-data-dir="\$PROFILE_DIR" --app="\$URL" --kiosk \\
	--window-position="\$at" --no-first-run --no-default-browser-check --noerrdialogs --disable-session-crashed-bubble
DISPLAY
	chmod 755 "$RES/display"
fi
if [ -n "$REGISTER" ]; then
	umask 077
	printf "CF_ACCESS_CLIENT_ID='%s'\nCF_ACCESS_CLIENT_SECRET='%s'\n" "$CF_ACCESS_CLIENT_ID" "$CF_ACCESS_CLIENT_SECRET" > "$RES/token"
fi

echo "Built $APP, for $API_URL"
if [ -n "$DISPLAY_TOO" ]; then echo "With a second monitor it opens the customer display there: pair it at the register with PF4, option 12."; fi
echo "Open it from Launchpad or Spotlight, or drag it to the Dock."
