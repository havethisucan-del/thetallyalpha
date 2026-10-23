#!/bin/bash
# Double-click to play The Tally on this Mac (README.md). Needs only Node.js.
# First open: right-click -> Open (macOS blocks downloaded scripts on a plain double-click).
cd "$(dirname "$0")" || exit 1

# Finder-launched shells may not have the usual PATH entries (official Node installer and
# Homebrew); add them, plus nvm's default Node if nvm is installed.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 && nvm use default >/dev/null 2>&1
fi

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "Node.js is not installed (or this window cannot find it)."
  echo "Install the \"LTS\" version from https://nodejs.org with the default options,"
  echo "then open \"Start The Tally.command\" again."
  echo
  read -r -p "Press Enter to close this window..." _
  exit 1
fi

if ! node scripts/launch.js; then
  echo
  echo "The Tally could not start or stopped with an error (see above)."
  read -r -p "Press Enter to close this window..." _
  exit 1
fi
