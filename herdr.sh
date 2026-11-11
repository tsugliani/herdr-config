#!/usr/bin/env bash
# Installs this repo's layouts and mods into the Herdr app's home, and brings
# changes made there back.
#
#   ./herdr.sh install [--force]   copy layouts/, themes/ and mods/ into Herdr, merge keys.json into its keys,
#                                  check the mods, switch layout and theme, and point Claude Code's
#                                  statusLine at the session bar's script, here and on each connected
#                                  machine with Claude Code (keys and statusLine need jq)
#   ./herdr.sh pull                copy edits made in Herdr back into this repo
#   ./herdr.sh status              what differs between this repo and Herdr
#   ./herdr.sh uninstall           remove them from Herdr (back to the main layout, the previous statusLine and keys)
#
# Copies, not symlinks: Herdr doesn't hot-reload a mod folder that is a symlink.
# keys.json is the whole keymap (Herdr's defaults plus this repo's changes), to read and edit
# in one place: install merges it into Herdr's own keys.json (keys only the person has stay),
# keeping Herdr's file as it was the first time; uninstall puts that file back.
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
  [ -n "$(keys_query clashes)" ] && echo "keys.json"
  return 0
}

# ── Keys: this repo's keys.json, merged into Herdr's ─────────────────────────────────────
KEYS="$REPO/keys.json"
KEYS_HOME="$HOME_DIR/keys.json"
KEYS_PREV="$HOME_DIR/backups/keys.prev.json"
# Each of this repo's keys as [section, key, action]; $h is Herdr's keys.json.
KEYS_EACH='$r[0] | to_entries[] | .key as $s | .value | to_entries[] | [$s, .key, .value]'
keys_ready() { [ -f "$KEYS" ] && [ -f "$KEYS_HOME" ] && command -v jq >/dev/null; }

# One line per key: clashes (Herdr binds it to something else) or missing (not bound there).
keys_query() {
  keys_ready || return 0
  local test
  case "$1" in
    clashes) test='$h[0][$e[0]][$e[1]] != null and $h[0][$e[0]][$e[1]] != $e[2]' ;;
    missing) test='$h[0][$e[0]][$e[1]] == null' ;;
  esac
  jq -rn --slurpfile r "$KEYS" --slurpfile h "$KEYS_HOME" \
    "$KEYS_EACH | . as \$e | select($test) | \"\(\$e[0]): \(\$e[1])\""
}

# Rewrites Herdr's keys.json through a jq filter ($r is this repo's keys), only when it changes.
keys_write() {
  local next; next="$(jq --slurpfile r "$KEYS" "$1" "$KEYS_HOME")"
  [ "$(jq -S . <<<"$next")" = "$(jq -S . "$KEYS_HOME")" ] && return 1
  printf '%s\n' "$next" > "$KEYS_HOME.tmp" && mv -f "$KEYS_HOME.tmp" "$KEYS_HOME"
}

install_keys() {
  [ -f "$KEYS" ] || return 0
  command -v jq >/dev/null || { echo "jq is missing (brew install jq): keys.json not merged"; return; }
  [ -f "$KEYS_HOME" ] || { echo "No $KEYS_HOME yet (start Herdr once): keys.json not merged"; return; }
  [ -f "$KEYS_PREV" ] || { mkdir -p "$HOME_DIR/backups"; cp "$KEYS_HOME" "$KEYS_PREV"; }
  if keys_write "reduce ($KEYS_EACH) as \$e (.; .[\$e[0]][\$e[1]] = \$e[2])"; then
    echo "merged keys.json into Herdr's keys"
  else
    echo "Herdr's keys already have keys.json"
  fi
}

# keys.json becomes Herdr's whole keymap as it is now.
pull_keys() {
  keys_ready || return 0
  cp "$KEYS_HOME" "$KEYS"
}

# Herdr's keys.json goes back to how install first found it. Never strips keys one by one:
# keys.json holds Herdr's defaults too, so that would take out nearly every key.
uninstall_keys() {
  [ -f "$KEYS_PREV" ] || return 0
  mv -f "$KEYS_PREV" "$KEYS_HOME"
  echo "restored Herdr's previous keys"
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

# ── The same on the other machines (hc machine ls), each from its own home ─────────────────
# The script goes to REMOTE_DIR there; the previous statusLine and a settings backup beside it.
HC="$(command -v hc || echo "$HOME/.local/bin/hc")"
REMOTE_DIR='$HOME/.local/share/herdr-tsugliani-session-bar'
REMOTE_COMMON='d='"$REMOTE_DIR"'; s="$HOME/.claude/settings.json"; me="$d/claude-statusline.sh"
now() { [ -f "$s" ] && jq -r ".statusLine.command // \"\"" "$s" 2>/dev/null || true; }'
# stdin: the script. Prints what it did, one word.
REMOTE_INSTALL="$REMOTE_COMMON"'
{ command -v claude || [ -x "$HOME/.local/bin/claude" ]; } >/dev/null 2>&1 || { echo no-claude; exit 0; }
command -v jq >/dev/null 2>&1 || { echo no-jq; exit 0; }
mkdir -p "$d/backups" && cat > "$me.tmp" && chmod +x "$me.tmp" && mv -f "$me.tmp" "$me" || exit 1
[ "$(now)" = "$me" ] && { echo already; exit 0; }
[ -f "$s" ] || { mkdir -p "$HOME/.claude"; echo "{}" > "$s"; }
cp "$s" "$d/backups/settings-$(date +%Y%m%d-%H%M%S).json"
jq ".statusLine // null" "$s" > "$d/statusline.prev.json"
jq --arg c "$me" ".statusLine = {type: \"command\", command: \$c}" "$s" > "$s.tmp" && mv -f "$s.tmp" "$s" && echo set'
REMOTE_UNINSTALL="$REMOTE_COMMON"'
command -v jq >/dev/null 2>&1 || exit 0
if [ "$(now)" = "$me" ]; then
  p="$d/statusline.prev.json"
  if [ -s "$p" ] && [ "$(cat "$p")" != null ]; then jq --slurpfile p "$p" ".statusLine = \$p[0]" "$s" > "$s.tmp"
  else jq "del(.statusLine)" "$s" > "$s.tmp"; fi
  mv -f "$s.tmp" "$s" && echo restored
fi
rm -f "$me" "$d/statusline.prev.json"'
REMOTE_STATUS="$REMOTE_COMMON"'
{ command -v claude || [ -x "$HOME/.local/bin/claude" ]; } >/dev/null 2>&1 || { echo no-claude; exit 0; }
[ "$(now)" = "$me" ] && echo ours || echo other'

remote_machines() {
  [ -x "$HC" ] && command -v jq >/dev/null || return 0
  "$HC" machine ls --json 2>/dev/null | jq -r '.machines[] | select(.state == "connected" and (.temporary | not)) | .name' || true
}
remote_offline() {
  [ -x "$HC" ] && command -v jq >/dev/null || return 0
  "$HC" machine ls --json 2>/dev/null | jq -r '.machines[] | select(.state != "connected" and (.temporary | not)) | .name' || true
}

install_remote_statusline() {
  local m r
  for m in $(remote_machines); do
    r="$("$HC" exec --on "$m" -i sh -c "$REMOTE_INSTALL" < "$REPO/mods/herdr-tsugliani-session-bar/claude-statusline.sh" 2>&1)" || r="failed: $r"
    case "$r" in
      set) echo "$m: Claude Code's statusLine now runs claude-statusline.sh" ;;
      already) echo "$m: Claude Code's statusLine already runs claude-statusline.sh (script updated)" ;;
      no-claude) ;;
      no-jq) echo "$m: jq is missing there: its Claude usage won't show in the session bar" ;;
      *) echo "$m: couldn't set Claude Code's statusLine: $r" ;;
    esac
  done
  for m in $(remote_offline); do echo "$m: not connected, its statusLine was left alone"; done
}

uninstall_remote_statusline() {
  local m r
  for m in $(remote_machines); do
    r="$("$HC" exec --on "$m" sh -c "$REMOTE_UNINSTALL" 2>&1)" || r="failed: $r"
    case "$r" in
      restored) echo "$m: restored Claude Code's previous statusLine" ;;
      "") ;;
      *) echo "$m: couldn't restore Claude Code's statusLine: $r" ;;
    esac
  done
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
  install_keys
  install_statusline
  install_remote_statusline
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
  pull_keys
  echo "pulled into $REPO"
}

status() {
  local clash; clash="$(conflicts)"
  for m in $(mods); do [ -e "$HOME_DIR/mods/$m" ] || echo "not installed: mods/$m"; done
  for f in $(files); do [ -e "$HOME_DIR/$f" ] || echo "not installed: $f"; done
  keys_query missing | sed 's/^/not installed: keys.json /'
  if [ -n "$clash" ]; then echo "differs:"; echo "$clash" | sed 's/^/  /'; else echo "installed copies match this repo"; fi
  local sl; sl="$(statusline_now)"
  if [ "$sl" = "$STATUSLINE" ]; then echo "Claude Code's statusLine runs claude-statusline.sh"
  elif [ -n "$sl" ]; then echo "Claude Code's statusLine is something else (no usage in the session bar): ${sl:0:60}…"
  else echo "Claude Code has no statusLine (no usage in the session bar)"; fi
  local m r
  for m in $(remote_machines); do
    r="$("$HC" exec --on "$m" sh -c "$REMOTE_STATUS" 2>/dev/null)" || r="unknown"
    case "$r" in
      ours) echo "$m: Claude Code's statusLine runs claude-statusline.sh" ;;
      other) echo "$m: Claude Code's statusLine is something else (no usage in the session bar)" ;;
      no-claude) ;;
      *) echo "$m: couldn't check Claude Code's statusLine" ;;
    esac
  done
}

uninstall() {
  if running && [ "$(herdr-app status | sed -n 's/.*"layout": "\(.*\)".*/\1/p')" = "$LAYOUT" ]; then
    herdr-app do layout.switch --name main >/dev/null
  fi
  uninstall_statusline
  uninstall_remote_statusline
  uninstall_keys
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
