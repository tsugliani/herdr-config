// node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { level, timeLeft, ago, isStale, elapsed, meterView, modelName, windowLabel, STALE_MS, speedView } from "../mods/herdr-tsugliani-session-bar/usage.js";

const NOW = 1_800_000_000; // seconds
const H = 3600, D = 86400;

test("limits turn amber at 70 and red at 90; the context at 80 and 95", () => {
  assert.equal(level("5h", 69), "ok");
  assert.equal(level("5h", 70), "warn");
  assert.equal(level("7d", 90), "hot");
  assert.equal(level("ctx", 79), "ok");
  assert.equal(level("ctx", 80), "warn");
  assert.equal(level("ctx", 95), "hot");
});

test("time left reads like a clock", () => {
  assert.equal(timeLeft(30), "<1m");
  assert.equal(timeLeft(38 * 60), "38m");
  assert.equal(timeLeft(2 * H + 10 * 60), "2h 10m");
  assert.equal(timeLeft(2 * D + 10 * H + 59 * 60), "2d 10h");
});

test("a calm limit shows its percent only; a warm one adds the time to reset", () => {
  const calm = meterView({ label: "7d", percent: 41.2, resets_at: NOW + 2 * D + 10 * H }, NOW);
  assert.equal(calm.text, "41%");
  assert.equal(calm.brief, "41%");
  assert.equal(calm.level, "ok");
  assert.equal(calm.long, "Weekly");
  assert.equal(calm.left, "2d 10h");
  const warm = meterView({ label: "5h", percent: 74, resets_at: NOW + 38 * 60 }, NOW);
  assert.equal(warm.text, "74% · 38m");
  assert.equal(warm.brief, "74%");
  assert.equal(warm.level, "warn");
});

test("the tick is the share of the window already passed, and the hint reads it", () => {
  const v = meterView({ label: "5h", percent: 5, resets_at: NOW + 4 * H }, NOW); // 1 h into 5
  assert.ok(Math.abs(v.tick - 0.2) < 1e-9);
  assert.match(v.hint, /20% of the time has passed/);
  assert.match(v.hint, /room to spare/);
  assert.match(meterView({ label: "5h", percent: 60, resets_at: NOW + 4 * H }, NOW).hint, /too fast/);
  assert.match(meterView({ label: "5h", percent: 25, resets_at: NOW + 4 * H }, NOW).hint, /on pace/);
  assert.equal(elapsed({ label: "ctx", percent: 10 }, NOW), null);
  assert.equal(meterView({ label: "ctx", percent: 42 }, NOW).tick, null);
  assert.equal(meterView({ label: "ctx", percent: 42 }, NOW).long, "Context");
});

test("a passed reset shows — until the next reading", () => {
  const v = meterView({ label: "5h", percent: 99, resets_at: NOW - 1 }, NOW);
  assert.equal(v.text, "—");
  assert.equal(v.brief, "—");
  assert.equal(v.expired, true);
  assert.equal(v.fill, 0);
  assert.equal(v.level, "ok");
});

test("staleness, ago, model and window names", () => {
  const ms = NOW * 1000;
  assert.equal(isStale(ms - STALE_MS - 1, ms), true);
  assert.equal(isStale(ms - 60_000, ms), false);
  assert.equal(isStale(null, ms), true);
  assert.equal(ago(ms - 10_000, ms), "just now");
  assert.equal(ago(ms - 5 * 60_000, ms), "5 min ago");
  assert.equal(ago(ms - 3 * H * 1000, ms), "3 h ago");
  assert.equal(modelName("claude-fable-5-1[1m]"), "Fable 5.1");
  assert.equal(modelName("claude-opus-4-8"), "Opus 4.8");
  assert.equal(modelName(null), "");
  assert.equal(windowLabel(1_000_000), "1M");
  assert.equal(windowLabel(200_000), "200k");
  assert.equal(windowLabel(null), null);
});

test("speed reads per reply, with the session average in the card", () => {
  assert.equal(speedView(null), null);
  assert.equal(speedView({ last: null, avg: null }), null);
  const v = speedView({ last: { tps: 63, tokens: 1200, ms: 19000, at: 1 }, avg: 58 });
  assert.equal(v.bar, "63 tok/s");
  assert.equal(v.card, "63 tok/s · 58 avg");
  assert.equal(v.detail, "last reply: 1,200 tokens in 19s");
  assert.equal(speedView({ last: { tps: 90, tokens: 450, ms: 5000 }, avg: null }).card, "90 tok/s");
  assert.equal(speedView({ last: { tps: 90, tokens: 450, ms: 5000 } }).detail, "last reply: 450 tokens in 5s");
});
