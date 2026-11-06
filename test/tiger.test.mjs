// node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { W, H, FRAMES } from "../mods/herdr-tsugliani-tiger/sprite.js";

test("every frame is W by H of palette letters", () => {
  assert.ok(FRAMES.length >= 2);
  for (const frame of FRAMES) {
    assert.equal(frame.length, H);
    for (const row of frame) {
      assert.equal(row.length, W);
      assert.match(row, /^[.odkwp]+$/);
    }
  }
});

test("every frame has a whole tiger: orange, stripes, a cream muzzle, pink ears", () => {
  for (const frame of FRAMES) {
    const all = frame.join("");
    for (const c of "okwpd") assert.ok(all.includes(c), `no ${c}`);
  }
});

test("the tiger moves: at least three distinct frames, and the tail differs", () => {
  const distinct = new Set(FRAMES.map((f) => f.join("\n")));
  assert.ok(distinct.size >= 3);
  // The tail lives in the left six columns; it must not sit still across the cycle.
  const tails = new Set(FRAMES.map((f) => f.map((row) => row.slice(0, 6)).join("\n")));
  assert.ok(tails.size >= 2);
});
