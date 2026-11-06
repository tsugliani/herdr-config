// node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { W, H, FRAMES } from "../mods/herdr-tsugliani-octopus/sprite.js";

test("every frame is W by H of palette letters", () => {
  assert.ok(FRAMES.length >= 2);
  for (const frame of FRAMES) {
    assert.equal(frame.length, H);
    for (const row of frame) {
      assert.equal(row.length, W);
      assert.match(row, /^[.pdlwkcb]+$/);
    }
  }
});

test("every frame has a whole octopus: purple body, dark mantle, eyes or a blink, cheeks", () => {
  for (const frame of FRAMES) {
    const all = frame.join("");
    for (const c of "pdlkc") assert.ok(all.includes(c), `no ${c}`);
  }
  assert.ok(FRAMES.some((f) => f.join("").includes("w")), "never has open eyes");
  assert.ok(FRAMES.some((f) => !f.join("").includes("w")), "never blinks");
});

test("it moves: it bobs, the tentacles ripple and the bubbles rise", () => {
  const firstBody = (f) => f.findIndex((row) => row.includes("p"));
  assert.ok(new Set(FRAMES.map(firstBody)).size >= 2, "no bob");
  // Tentacles live below the mantle row; their shape must change across the cycle.
  const tentacles = (f) => f.slice(f.findIndex((row) => row.includes("d")) + 1).join("\n");
  assert.ok(new Set(FRAMES.map(tentacles)).size >= 4, "tentacles don't ripple");
  const bubbleRows = new Set(FRAMES.map((f) => f.findIndex((row) => row.includes("b"))));
  assert.ok(bubbleRows.size >= 4, "bubbles don't rise");
});
