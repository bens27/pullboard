#!/bin/sh
# Installs the repo's Pullboard panel mod into Herdr's app home, which is where
# Herdr loads it from; the repo copy is never loaded directly.
# Usage: scripts/install-herdr-mod.sh [--dry-run]
# The old copy is backed up under $HERDR_APP_HOME/mod-backups, outside mods/, so
# Herdr never loads a backup. Files only the installed copy has (local type stubs,
# editor config) are kept. Layouts, other mods and the app process are untouched.
set -eu

dry_run=0
case "${1-}" in
  '') ;;
  --dry-run) dry_run=1 ;;
  *) echo "usage: scripts/install-herdr-mod.sh [--dry-run]" >&2; exit 2 ;;
esac
[ $# -le 1 ] || { echo "usage: scripts/install-herdr-mod.sh [--dry-run]" >&2; exit 2; }

root=$(cd "$(dirname "$0")/.." && pwd)
rel=integrations/herdr-app/mods/pullboard
source="$root/$rel"
app="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
dest="$app/mods/pullboard"

# A missing app home means Herdr was never run here or the variable is wrong;
# creating it would hide that mistake.
[ -d "$app" ] || { echo "no Herdr app home at $app; set HERDR_APP_HOME" >&2; exit 1; }

# Only tracked files ship, so scratch files in the repo folder never reach Herdr.
files=$(git -C "$root" ls-files -- "$rel" | sed "s|^$rel/||" | grep -E '^([^/]+\.js|mod\.json|README\.md)$' || true)
[ -n "$files" ] || { echo "no tracked mod files under $rel" >&2; exit 1; }

changes=''
for file in $files; do
  if [ ! -e "$dest/$file" ]; then changes="$changes
added $file"
  elif ! cmp -s "$source/$file" "$dest/$file"; then changes="$changes
updated $file"
  fi
done
changes=${changes#?}

if [ -z "$changes" ]; then echo "no files changed"; exit 0; fi

if [ "$dry_run" -eq 1 ]; then
  printf '%s\n' "$changes"
  echo "dry run: nothing written to $dest"
  exit 0
fi

if [ -d "$dest" ]; then
  mkdir -p "$app/mod-backups"
  backup="$app/mod-backups/pullboard-$(date +%Y%m%d-%H%M%S)"
  [ ! -e "$backup" ] || backup="$backup-$$"
  cp -Rp "$dest" "$backup"
  echo "backup $backup"
fi

mkdir -p "$dest"
printf '%s\n' "$changes" | while read -r _ file; do
  cp "$source/$file" "$dest/.$file.installing"
  mv "$dest/.$file.installing" "$dest/$file"
done
printf '%s\n' "$changes"
echo "installed into $dest"
