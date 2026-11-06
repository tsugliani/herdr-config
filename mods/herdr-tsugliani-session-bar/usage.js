// The Claude side of the bar as plain functions: what a meter's number, bar, tick and
// time mean. No Herdr imports, so `node --test` checks them (test/session-bar.test.mjs).
// Thresholds, tick and wording follow nozikov/herdr-usage-limits (MIT).

export const WARN = 70, HOT = 90;          // a limit turns amber, then red
export const CTX_WARN = 80, CTX_HOT = 95;  // the context window: compaction territory
export const STALE_MS = 15 * 60 * 1000;    // a reading older than this is dimmed
export const PACE_MARGIN = 10;             // percentage points before "ahead" / "under"
const SPAN = { "5h": 5 * 3600, "7d": 7 * 86400 }; // seconds a limit's window covers
export const LONG = { ctx: "Context", "5h": "5-hour", "7d": "Weekly" };

// "claude-opus-4-8[1m]" → "Opus 4.8"; anything else as given.
export function modelName(id) {
  const m = /(opus|sonnet|haiku|fable)[-_ ]?(\d+)?(?:[-.](\d+))?/i.exec(id ?? "");
  if (!m) return id ?? "";
  return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()}${m[2] ? ` ${m[2]}${m[3] ? `.${m[3]}` : ""}` : ""}`;
}

export const windowLabel = (n) => (!n ? null : n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}k`);

export function level(label, percent) {
  const [warn, hot] = label === "ctx" ? [CTX_WARN, CTX_HOT] : [WARN, HOT];
  return percent >= hot ? "hot" : percent >= warn ? "warn" : "ok";
}

export function timeLeft(sec) {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return "<1m";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function ago(ms, nowMs) {
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export const isStale = (atMs, nowMs) => atMs == null || nowMs - atMs > STALE_MS;

// How much of a limit's window has passed, 0..1; null when the meter has no window.
export function elapsed(m, nowSec) {
  const span = SPAN[m.label];
  if (!span || m.resets_at == null) return null;
  return Math.min(1, Math.max(0, 1 - (m.resets_at - nowSec) / span));
}

const VERDICT = { ahead: "you're using it up too fast", under: "you have room to spare", "on pace": "you're on pace" };

// One meter as the bar and the card draw it. `text` is the full reading, `brief` what is
// left when the bar runs out of room: an amber or red limit keeps its time, a calm one
// never shows it.
export function meterView(m, nowSec) {
  const long = LONG[m.label] ?? m.label;
  if (m.resets_at != null && m.resets_at <= nowSec) {
    return { label: m.label, long, percent: null, text: "—", brief: "—", level: "ok", fill: 0, tick: null, left: "", hint: "Reset: waiting for Claude's next reply", expired: true };
  }
  const percent = Math.max(0, Math.round(m.percent ?? 0));
  const lv = level(m.label, percent);
  const left = m.resets_at != null ? timeLeft(m.resets_at - nowSec) : "";
  const tick = elapsed(m, nowSec);
  const clock = tick == null ? null : Math.round(tick * 100);
  const verdict = clock == null ? null : percent > clock + PACE_MARGIN ? "ahead" : percent < clock - PACE_MARGIN ? "under" : "on pace";
  const hint = clock == null ? null : `Tick: ${clock}% of the time has passed.\nYou've used ${percent}%, so ${VERDICT[verdict]}.`;
  const brief = `${percent}%`;
  return { label: m.label, long, percent, text: lv !== "ok" && left ? `${brief} · ${left}` : brief, brief, level: lv, fill: Math.min(1, percent / 100), tick, left, hint, expired: false };
}

// Writing speed, from the status line script's per-reply estimate (claude-statusline.sh).
// null until a reply of 100+ tokens was measured. `bar` is the chip text; `card` the
// card's line, with the reply's tokens and seconds and the session average.
export function speedView(speed) {
  const last = speed?.last;
  if (!last || !(last.tps > 0)) return null;
  const secs = last.ms >= 10000 ? Math.round(last.ms / 1000) : Math.round(last.ms / 100) / 10;
  const detail = `last reply: ${last.tokens.toLocaleString("en-US")} tokens in ${secs}s`;
  return {
    bar: `${last.tps} tok/s`,
    card: speed.avg ? `${last.tps} tok/s · ${speed.avg} avg` : `${last.tps} tok/s`,
    detail,
    at: last.at ?? null,
  };
}
