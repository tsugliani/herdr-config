// node --test
// Runs the session bar's Claude Code status line script against a scratch HOME.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../mods/herdr-tsugliani-session-bar/claude-statusline.sh", import.meta.url));
const skip = spawnSync("jq", ["--version"]).status === 0 ? false : "jq is not installed";
const NOW = Math.floor(Date.now() / 1000);
const FULL = {
  model: { id: "claude-fable-5-1[1m]", display_name: "Fable" },
  effort: { level: "xhigh" },
  context_window: { context_window_size: 1000000, used_percentage: 41.6 },
  rate_limits: { five_hour: { used_percentage: 23.5, resets_at: NOW + 4 * 3600 }, seven_day: { used_percentage: 41.2, resets_at: NOW + 5 * 86400 } },
};

function run(payload, env = {}, home = mkdtempSync(join(tmpdir(), "sb-"))) {
  const input = typeof payload === "string" ? payload : `${JSON.stringify(payload)}\n`;
  const r = spawnSync("/bin/sh", [SCRIPT], { input, encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, ...env } });
  return { home, r, dir: join(home, ".local/state/herdr-session-bar") };
}
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

test("inside a Herdr terminal it writes the session and the account limits, and prints nothing", { skip }, () => {
  const { r, dir } = run(FULL, { HC_TERMINAL_ID: "t7" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  const s = readJson(join(dir, "t7.json"));
  assert.equal(s.model, "claude-fable-5-1[1m]");
  assert.equal(s.effort, "xhigh");
  assert.equal(s.window, 1000000);
  assert.deepEqual(s.meters.map((m) => [m.label, m.percent]), [["ctx", 42], ["5h", 24], ["7d", 41]]);
  assert.equal(s.meters[1].resets_at, NOW + 4 * 3600);
  assert.ok(Math.abs(s.at - Date.now()) < 10_000);
  const l = readJson(join(dir, "limits.json"));
  assert.equal(l.terminal, "t7");
  assert.deepEqual(l.meters.map((m) => [m.label, m.percent, m.resets_at]), [["5h", 24, NOW + 4 * 3600], ["7d", 41, NOW + 5 * 86400]]);
  assert.deepEqual(readdirSync(dir).sort(), ["limits.json", "t7.json"]); // no temp file left behind
});

test("outside Herdr, or with an odd terminal id, it writes nothing", () => {
  for (const env of [{}, { HC_TERMINAL_ID: "../x" }, { HC_TERMINAL_ID: "limits" }, { HC_TERMINAL_ID: "" }]) {
    const { r, dir } = run(FULL, env);
    assert.equal(r.status, 0);
    assert.equal(existsSync(dir), false, JSON.stringify(env));
  }
});

test("without rate limits the session has no limit meters and limits.json keeps the last reading", { skip }, () => {
  const first = run(FULL, { HC_TERMINAL_ID: "t2" });
  const before = readFileSync(join(first.dir, "limits.json"), "utf8");
  const again = run({ model: { id: "claude-fable-5-1" }, context_window: { context_window_size: 200000, used_percentage: null } }, { HC_TERMINAL_ID: "t2" }, first.home);
  assert.equal(again.r.status, 0);
  const s = readJson(join(again.dir, "t2.json"));
  assert.deepEqual(s.meters, []);
  assert.equal(s.effort, null);
  assert.equal(s.window, 200000);
  assert.equal(readFileSync(join(again.dir, "limits.json"), "utf8"), before);
});

test("empty input is ignored", () => {
  const { r, dir } = run("", { HC_TERMINAL_ID: "t7" });
  assert.equal(r.status, 0);
  assert.equal(existsSync(dir), false);
});

test("speed: each reply's tokens over the API wait it added; tool calls and repeats skipped; new session resets", { skip }, () => {
  const home = mkdtempSync(join(tmpdir(), "sb-"));
  const step = (sid, apiMs, out) => {
    run({ session_id: sid, cost: { total_api_duration_ms: apiMs }, context_window: { current_usage: { output_tokens: out } } }, { HC_TERMINAL_ID: "t1" }, home);
    return readJson(join(home, ".local/state/herdr-session-bar/t1.json")).speed;
  };
  assert.equal(step("a", 0, 0).last, null);             // baseline
  let s = step("a", 20000, 1200);                       // 1200 tokens in 20 s
  assert.equal(s.last.tps, 60);
  assert.equal(s.avg, 60);
  assert.equal(step("a", 20000, 1200).out, 1200);       // same reply seen again: not counted twice
  assert.equal(step("a", 23000, 40).last.tps, 60);      // a 40-token tool call: left out
  s = step("a", 33000, 800);                            // 800 in 10 s
  assert.equal(s.last.tps, 80);
  assert.equal(s.avg, 67);                              // 2000 tokens over 30 s
  s = step("b", 5000, 300);                             // another session: baseline again
  assert.equal(s.last, null);
  assert.equal(s.out, 0);
});
