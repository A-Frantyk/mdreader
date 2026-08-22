#!/bin/sh
# Downloads the latest mdreader macOS release, verifies its checksum,
# installs it to /Applications, and strips the quarantine attribute so
# it launches with no Gatekeeper prompt.
#
# The app is ad-hoc signed, not notarized (no paid Apple Developer
# Program membership — see CLAUDE.md's signing invariant), so macOS
# would otherwise show "Apple could not verify ... is free of malware"
# on first launch. Read this script before running it: it never uses
# sudo and never disables Gatekeeper system-wide (no
# `spctl --master-disable`) — it only clears com.apple.quarantine on
# the one app bundle it just installed, which is what removes the
# per-download quarantine flag that triggers the assessment.
#
# Usage:
#   curl -fsSL -o install-macos.sh https://raw.githubusercontent.com/A-Frantyk/mdreader/main/scripts/install-macos.sh
#   less install-macos.sh   # read it
#   sh install-macos.sh

set -eu

REPO="A-Frantyk/mdreader"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"

echo "Fetching latest release info for ${REPO}..."
RELEASE_JSON=$(curl -fsSL "$API_URL")

DMG_URL=$(printf '%s\n' "$RELEASE_JSON" | grep -o '"browser_download_url": *"[^"]*\.dmg"' | sed -E 's/.*"(https[^"]+)"/\1/' | head -n1)
SUMS_URL=$(printf '%s\n' "$RELEASE_JSON" | grep -o '"browser_download_url": *"[^"]*SHA256SUMS-macos\.txt"' | sed -E 's/.*"(https[^"]+)"/\1/' | head -n1)

if [ -z "$DMG_URL" ] || [ -z "$SUMS_URL" ]; then
  echo "Could not find a .dmg and/or SHA256SUMS-macos.txt in the latest release." >&2
  echo "Check https://github.com/${REPO}/releases/latest manually." >&2
  exit 1
fi

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

DMG_NAME=$(basename "$DMG_URL")

echo "Downloading ${DMG_NAME}..."
curl -fsSL -o "${WORKDIR}/${DMG_NAME}" "$DMG_URL"
curl -fsSL -o "${WORKDIR}/SHA256SUMS-macos.txt" "$SUMS_URL"

echo "Verifying checksum (proves the download matches what CI built —"
echo "not a substitute for code signing, since both files come from the"
echo "same unsigned release)..."
(
  cd "$WORKDIR"
  grep -F "$DMG_NAME" SHA256SUMS-macos.txt | shasum -a 256 -c -
)

echo "Mounting disk image..."
MOUNT_POINT=$(hdiutil attach -nobrowse -quiet "${WORKDIR}/${DMG_NAME}" | awk -F'\t' '/\/Volumes\// {print $NF; exit}')

if [ -z "$MOUNT_POINT" ]; then
  echo "Could not determine mount point for ${DMG_NAME}." >&2
  exit 1
fi

APP_PATH=$(find "$MOUNT_POINT" -maxdepth 1 -name '*.app' | head -n1)

if [ -z "$APP_PATH" ]; then
  echo "No .app bundle found inside ${DMG_NAME}." >&2
  hdiutil detach -quiet "$MOUNT_POINT" || true
  exit 1
fi

APP_NAME=$(basename "$APP_PATH")

echo "Installing ${APP_NAME} to /Applications..."
rm -rf "/Applications/${APP_NAME}"
ditto "$APP_PATH" "/Applications/${APP_NAME}"

hdiutil detach -quiet "$MOUNT_POINT"

echo "Removing quarantine attribute so it launches without a Gatekeeper prompt..."
xattr -dr com.apple.quarantine "/Applications/${APP_NAME}"

echo "Registering with Launch Services (enables .md \"Open With\")..."
open -a "/Applications/${APP_NAME}" --hide

echo "Done. ${APP_NAME} is installed in /Applications."
