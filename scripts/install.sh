#!/bin/sh
# Plainly installer for macOS on Apple Silicon.
#
#   curl -fsSL https://github.com/dataguyofprocol/plainly/releases/latest/download/install.sh | sh
#
# Uploaded to every GitHub release next to the zip and latest-mac.yml.
# Plainly is ad-hoc signed, not notarized. A browser download is quarantined
# and Gatekeeper calls it malware; curl sets no quarantine flag, so an app
# installed this way opens normally. After this, the app updates itself
# (electron/mac-updater.cjs).
#
# LH_UPDATE_FEED overrides the feed URL (same seam as the app's updater),
# for testing against a local server.

set -eu

FEED="${LH_UPDATE_FEED:-https://github.com/dataguyofprocol/plainly/releases/latest/download}"
FEED="${FEED%/}"
APP="Plainly.app"
BUNDLE_ID="app.plainly.Plainly"

fail() {
	printf 'Plainly install: %s\n' "$*" >&2
	exit 1
}

# One function, called on the last line: a cut-off download runs nothing.
main() {
	[ "$(uname -s)" = Darwin ] || fail "this installer is for macOS only."
	[ "$(uname -m)" = arm64 ] || fail "Plainly needs a Mac with Apple Silicon."
	if pgrep -xq Plainly; then
		fail "Plainly is running. Quit it, then run this command again."
	fi

	tmp="$(mktemp -d)"
	trap 'rm -rf "$tmp"' EXIT

	curl -fsSL "$FEED/latest-mac.yml" -o "$tmp/latest-mac.yml" || fail "couldn't download $FEED/latest-mac.yml"
	version="$(awk '$1 == "version:" { gsub(/["'\'']/, "", $2); print $2; exit }' "$tmp/latest-mac.yml")"
	# shellcheck disable=SC2046
	set -- $(awk '
		/^[[:space:]]*- url:/ { inzip = !done && $3 ~ /\.zip$/; if (inzip) url = $3; next }
		inzip && $1 == "sha512:" { sha = $2 }
		inzip && $1 == "size:" { size = $2; done = 1; inzip = 0 }
		END { print url, sha, size }
	' "$tmp/latest-mac.yml")
	zip="${1:-}" sha512="${2:-}" size="${3:-}"
	[ -n "$version" ] && [ -n "$zip" ] && [ -n "$sha512" ] && [ -n "$size" ] || fail "latest-mac.yml has no version or zip entry"
	case "$zip" in */* | *..*) fail "latest-mac.yml zip url is not a bare file name: $zip" ;; esac

	printf 'Downloading Plainly %s…\n' "$version"
	curl -fL --progress-bar "$FEED/$zip" -o "$tmp/$zip" || fail "couldn't download $FEED/$zip"
	[ "$(stat -f %z "$tmp/$zip")" = "$size" ] || fail "download size doesn't match latest-mac.yml"
	[ "$(openssl dgst -sha512 -binary "$tmp/$zip" | base64)" = "$sha512" ] || fail "download sha512 doesn't match latest-mac.yml"

	ditto -x -k "$tmp/$zip" "$tmp/unpacked"
	new="$tmp/unpacked/$APP"
	plist="$new/Contents/Info.plist"
	[ -f "$plist" ] || fail "the zip has no $APP"
	[ "$(plutil -extract CFBundleIdentifier raw -o - "$plist")" = "$BUNDLE_ID" ] || fail "the zip holds a different app"
	[ "$(plutil -extract CFBundleShortVersionString raw -o - "$plist")" = "$version" ] || fail "the app's version doesn't match latest-mac.yml"
	codesign --verify --deep --strict "$new" 2>/dev/null || fail "the app's code signature doesn't verify"
	xattr -dr com.apple.quarantine "$new" 2>/dev/null || true

	if [ -d "$HOME/Applications/$APP" ] && [ ! -d "/Applications/$APP" ]; then
		dest="$HOME/Applications"
	elif [ -w /Applications ]; then
		dest="/Applications"
	else
		dest="$HOME/Applications"
	fi
	mkdir -p "$dest"
	target="$dest/$APP"

	if [ -e "$target" ]; then
		rm -rf "$target.plainly-old"
		mv "$target" "$target.plainly-old"
		if ! mv "$new" "$target"; then
			mv "$target.plainly-old" "$target"
			fail "couldn't replace $target"
		fi
		rm -rf "$target.plainly-old"
	else
		mv "$new" "$target"
	fi

	printf 'Installed Plainly %s in %s\n' "$version" "$dest"
	open "$target"
}

main "$@"
