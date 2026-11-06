#!/usr/bin/env bash
# Installs this repo's layouts and mods into the Herdr app's home, and brings
# changes made there back.
#
#   ./herdr.sh install [--force]   copy layouts/, themes/ and mods/ into Herdr, check the mods, switch layout and theme,
#                                  and point Claude Code's statusLine at the session bar's script (needs jq)
#   ./herdr.sh pull                copy edits made in Herdr back into this repo
#   ./herdr.sh status              what differs between this repo and Herdr
#   ./herdr.sh uninstall           remove them from Herdr (back to the main layout and the previous statusLine)
#
# Copies, not symlinks: Herdr doesn't hot-reload a mod folder that is a symlink.
# HERDR_APP_HOME picks another Herdr home (default ~/.config/herdr-app).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
LAYOUT="herdr-tsugliani-git"
THEME="herdr-tsugliani-theme"
# Claude Code feeds the session bar through its status line: install points statusLine in
# its settings at the installed script, and keeps what was there for uninstall.
CLAUDE_SETTINGS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
STATUSLINE="$HOME_DIR/mods/herdr-tsugliani-session-bar/claude-statusline.sh"
STATUSLINE_PREV="$HOME_DIR/backups/claude-statusline.prev.json"
# Herdr writes these into every mod folder; they are not ours to keep.
EXCLUDES=(--exclude '*.d.ts' --exclude 'jsconfig.json' --exclude '.*')

mods() { for d in "$REPO"/mods/*/; do basename "$d"; done; }
# Single files, as paths under the home: layouts and themes.
files() { for f in "$REPO"/layouts/* "$REPO"/themes/*; do [ -f "$f" ] && echo "${f#$REPO/}"; done; }
running() { command -v herdr-app >/dev/null && herdr-app status >/dev/null 2>&1; }

# Items whose installed copy differs from this repo (a name taken by something else, or local edits).
conflicts() {
  for m in $(mods); do
    [ -e "$HOME_DIR/mods/$m" ] || continue
    diff -rq "${EXCLUDES[@]/--exclude/-x}" "$REPO/mods/$m" "$HOME_DIR/mods/$m" >/dev/null 2>&1 || echo "mods/$m"
  done
  for f in $(files); do
    [ -e "$HOME_DIR/$f" ] || continue
    cmp -s "$REPO/$f" "$HOME_DIR/$f" || echo "$f"
  done
}

statusline_now() { [ -f "$CLAUDE_SETTINGS" ] && jq -r '.statusLine.command // ""' "$CLAUDE_SETTINGS" 2>/dev/null || true; }

install_statusline() {
  if ! command -v jq >/dev/null; then echo "jq is missing (brew install jq): Claude usage won't show in the session bar"; return; fi
  [ -f "$CLAUDE_SETTINGS" ] || { mkdir -p "$(dirname "$CLAUDE_SETTINGS")"; echo '{}' > "$CLAUDE_SETTINGS"; }
  if [ "$(statusline_now)" = "$STATUSLINE" ]; then echo "Claude Code's statusLine already runs claude-statusline.sh"; return; fi
  mkdir -p "$HOME_DIR/backups"
  cp "$CLAUDE_SETTINGS" "$HOME_DIR/backups/claude-settings-$(date +%Y%m%d-%H%M%S).json"
  jq '.statusLine // null' "$CLAUDE_SETTINGS" > "$STATUSLINE_PREV"
  local next; next="$(jq --arg cmd "$STATUSLINE" '.statusLine = {type: "command", command: $cmd}' "$CLAUDE_SETTINGS")"
  printf '%s\n' "$next" > "$CLAUDE_SETTINGS"
  echo "Claude Code's statusLine now runs claude-statusline.sh: usage shows after each session's next reply"
}

uninstall_statusline() {
  command -v jq >/dev/null || return 0
  [ "$(statusline_now)" = "$STATUSLINE" ] || return 0
  local next
  if [ -s "$STATUSLINE_PREV" ] && [ "$(cat "$STATUSLINE_PREV")" != "null" ]; then
    next="$(jq --slurpfile prev "$STATUSLINE_PREV" '.statusLine = $prev[0]' "$CLAUDE_SETTINGS")"
    echo "restored Claude Code's previous statusLine"
  else
    next="$(jq 'del(.statusLine)' "$CLAUDE_SETTINGS")"
    echo "removed Claude Code's statusLine"
  fi
  printf '%s\n' "$next" > "$CLAUDE_SETTINGS"
  rm -f "$STATUSLINE_PREV"
}

install() {
  local force="${1:-}"
  [ -d "$HOME_DIR" ] || { echo "No Herdr home at $HOME_DIR (start Herdr once first)"; exit 1; }
  local clash; clash="$(conflicts)"
  if [ -n "$clash" ]; then
    if [ "$force" != "--force" ]; then
      echo "These already exist in $HOME_DIR and differ from this repo:"
      echo "$clash" | sed 's/^/  /'
      echo "Run './herdr.sh pull' to keep the installed version, or './herdr.sh install --force' to replace it (a backup is kept)."
      exit 1
    fi
    local backup="$HOME_DIR/backups/$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$backup"
    for item in $clash; do mkdir -p "$backup/$(dirname "$item")"; cp -R "$HOME_DIR/$item" "$backup/$item"; done
    echo "Backed up to $backup"
  fi
  mkdir -p "$HOME_DIR/mods" "$HOME_DIR/layouts" "$HOME_DIR/themes"
  for m in $(mods); do
    rsync -a --delete "${EXCLUDES[@]}" "$REPO/mods/$m/" "$HOME_DIR/mods/$m/"
    echo "installed mods/$m"
  done
  for f in $(files); do cp "$REPO/$f" "$HOME_DIR/$f"; echo "installed $f"; done
  install_statusline
  if running; then
    for m in $(mods); do herdr-app check "$HOME_DIR/mods/$m"; done
    herdr-app do layout.switch --name "$LAYOUT" >/dev/null && echo "switched to the $LAYOUT layout (ctrl-shift-l / cmd-shift-l cycles layouts)"
    herdr-app do app.theme --name "$THEME" >/dev/null && echo "switched to the $THEME theme"
  else
    echo "Herdr isn't running: pick the $LAYOUT layout and $THEME theme in Settings > Look next time."
  fi
}

pull() {
  for m in $(mods); do
    [ -d "$HOME_DIR/mods/$m" ] || { echo "skip mods/$m (not installed)"; continue; }
    rsync -a --delete "${EXCLUDES[@]}" "$HOME_DIR/mods/$m/" "$REPO/mods/$m/"
  done
  for f in $(files); do [ -f "$HOME_DIR/$f" ] && cp "$HOME_DIR/$f" "$REPO/$f"; done
  echo "pulled into $REPO"
}

status() {
  local clash; clash="$(conflicts)"
  for m in $(mods); do [ -e "$HOME_DIR/mods/$m" ] || echo "not installed: mods/$m"; done
  for f in $(files); do [ -e "$HOME_DIR/$f" ] || echo "not installed: $f"; done
  if [ -n "$clash" ]; then echo "differs:"; echo "$clash" | sed 's/^/  /'; else echo "installed copies match this repo"; fi
  local sl; sl="$(statusline_now)"
  if [ "$sl" = "$STATUSLINE" ]; then echo "Claude Code's statusLine runs claude-statusline.sh"
  elif [ -n "$sl" ]; then echo "Claude Code's statusLine is something else (no usage in the session bar): ${sl:0:60}…"
  else echo "Claude Code has no statusLine (no usage in the session bar)"; fi
}

uninstall() {
  if running && [ "$(herdr-app status | sed -n 's/.*"layout": "\(.*\)".*/\1/p')" = "$LAYOUT" ]; then
    herdr-app do layout.switch --name main >/dev/null
  fi
  uninstall_statusline
  for m in $(mods); do rm -rf "$HOME_DIR/mods/$m"; echo "removed mods/$m"; done
  for f in $(files); do rm -f "$HOME_DIR/$f"; echo "removed $f"; done
}

case "${1:-}" in
  install) install "${2:-}" ;;
  pull) pull ;;
  status) status ;;
  uninstall) uninstall ;;
  *) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
