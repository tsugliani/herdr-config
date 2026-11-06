#!/bin/sh
# herdr-tsugliani-session-bar, Claude Code's half. Claude Code runs this as its statusLine
# command and pipes its session JSON to it on every update. Inside a Herdr terminal
# (HC_TERMINAL_ID is set) it writes two files under ~/.local/state/herdr-session-bar/,
# which the mod watches:
#   <terminal>.json   this session: model, effort, context window, ctx / 5h / 7d meters,
#                     and its writing speed (see speed below)
#   limits.json       the account's 5h and 7d limits, from whichever session reported last
# Then it hands the same JSON to Orca's status line script, if Orca installed one, so Orca
# keeps its numbers when Claude runs there. It prints nothing: the bar is the display.
# `./herdr.sh install` points statusLine in ~/.claude/settings.json here. Needs jq.
set -u

payload=$(cat)
[ -n "$payload" ] || exit 0

terminal=${HC_TERMINAL_ID-}
case "$terminal" in
  ''|*[!A-Za-z0-9._-]*|limits) terminal= ;;
esac

if [ -n "$terminal" ] && command -v jq >/dev/null 2>&1; then
  dir="$HOME/.local/state/herdr-session-bar"
  mkdir -p "$dir" 2>/dev/null || dir=

  # A meter: label, whole percent, and for a limit the epoch second its window resets.
  #
  # Speed: Claude Code reports no tokens per second, so it is worked out per reply. Each run
  # sees the session's total time spent waiting for API responses and the last response's
  # output tokens. When the wait total grew since the previous run (kept in this file, per
  # session_id), one response finished: its tokens over that growth is its speed, time to
  # first token and thinking included. Replies under 100 tokens (mostly tool calls, where
  # the wait is nearly all time to first token) and readings outside 1..1000 tok/s are
  # left out. avg = all counted tokens over all counted time. The first run of a session
  # only sets the baseline.
  session='
    def limit($label): select(.used_percentage != null) | { label: $label, percent: (.used_percentage | round), resets_at };
    (.session_id // null) as $sid
    | (if ($prev | type) == "object" and $prev.session_id == $sid and $sid != null then $prev.speed else null end
       // { api_ms: null, out: 0, out_ms: 0, last: null }) as $s
    | (.cost.total_api_duration_ms // null) as $api
    | (.context_window.current_usage.output_tokens // .context_window.total_output_tokens // 0) as $tok
    | (if $api == null then $s
       elif $s.api_ms == null or $api < $s.api_ms then { api_ms: $api, out: 0, out_ms: 0, last: null }
       elif $api > $s.api_ms then
         ($api - $s.api_ms) as $d
         | ($tok * 1000 / $d) as $r
         | if $tok >= 100 and $d >= 500 and $r >= 1 and $r <= 1000
           then { api_ms: $api, out: ($s.out + $tok), out_ms: ($s.out_ms + $d),
                  last: { tps: ($r | round), tokens: $tok, ms: $d, at: (now * 1000 | floor) } }
           else $s + { api_ms: $api } end
       else $s end) as $speed
    | {
        model: .model.id,
        effort: .effort.level,
        window: .context_window.context_window_size,
        meters: [
          (.context_window.used_percentage | select(. != null) | { label: "ctx", percent: round }),
          (.rate_limits.five_hour | limit("5h")),
          (.rate_limits.seven_day | limit("7d"))
        ],
        session_id: $sid,
        speed: ($speed + { avg: (if $speed.out_ms > 0 then ($speed.out * 1000 / $speed.out_ms | round) else null end) }),
        at: (now * 1000 | floor)
      }'
  limits='
    def limit($label): select(.used_percentage != null) | { label: $label, percent: (.used_percentage | round), resets_at };
    { at: (now * 1000 | floor), terminal: $terminal,
      meters: [ (.rate_limits.five_hour | limit("5h")), (.rate_limits.seven_day | limit("7d")) ] }
    | select(.meters | length > 0)'

  if [ -n "$dir" ]; then
    tmp="$dir/.$terminal.$$"
    prev=$(cat "$dir/$terminal.json" 2>/dev/null) || prev=
    printf '%s' "$prev" | jq -e . >/dev/null 2>&1 || prev=null
    if printf '%s\n' "$payload" | jq -c --argjson prev "$prev" "$session" >"$tmp" 2>/dev/null && [ -s "$tmp" ]; then
      mv -f "$tmp" "$dir/$terminal.json"
    else
      rm -f "$tmp"
    fi
    if printf '%s\n' "$payload" | jq -c --arg terminal "$terminal" "$limits" >"$tmp" 2>/dev/null && [ -s "$tmp" ]; then
      mv -f "$tmp" "$dir/limits.json"
    else
      rm -f "$tmp"
    fi
  fi
fi

# Orca's own status line script, when Orca installed one: it reads the same JSON.
orca="$HOME/.orca/agent-hooks/claude-statusline.sh"
if [ -f "$orca" ] && [ -r "$orca" ] && [ -x "$orca" ]; then
  printf '%s\n' "$payload" | /bin/sh "$orca"
fi
exit 0
