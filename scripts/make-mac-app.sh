#!/bin/sh
# Builds a double-clickable POS launcher for macOS, for the Dock, Launchpad
# or Spotlight: it opens a Terminal window and runs the greenscreen
# terminal against the POS.
#
#   scripts/make-mac-app.sh                       # the back office, on the cloud
#   scripts/make-mac-app.sh [api-url]             # or another URL
#   scripts/make-mac-app.sh --register NAME [api-url]
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
if [ "${1:-}" = --register ]; then
	REGISTER=${2:?--register needs a name, e.g. "Lane 1"}
	shift 2
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
# script inside the app, then applies the profile and sizes the window.
osacompile -o "$APP" <<APPLESCRIPT
set run to quoted form of (POSIX path of (path to me) & "Contents/Resources/run")
tell application "Terminal"
	activate
	set t to do script run & "; exit"
	try
		set current settings of t to settings set "$PROFILE"
	end try
	delay 0.2
	set number of columns of front window to 100
	set number of rows of front window to 32
end tell
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
if [ -n "$REGISTER" ]; then
	umask 077
	printf "CF_ACCESS_CLIENT_ID='%s'\nCF_ACCESS_CLIENT_SECRET='%s'\n" "$CF_ACCESS_CLIENT_ID" "$CF_ACCESS_CLIENT_SECRET" > "$RES/token"
fi

echo "Built $APP, for $API_URL"
echo "Open it from Launchpad or Spotlight, or drag it to the Dock."
