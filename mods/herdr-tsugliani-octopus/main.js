// A small box in the sidebar, beside the tiger, with a pixel-art purple octopus that bobs,
// ripples its tentacles, blinks and lets bubbles rise. Drawn as herdr-tsugliani-tiger draws
// its tiger:
//
// no image file: every pixel is a "█" glyph of JetBrains Mono (0.6em wide, bundled with
// Herdr), one text row per sprite row and one layer per color, stacked. `.frames()` steps
// each row's text natively on the host's shared clock, so all layers change together and
// render() never runs for the animation. Rows are clipped to one cell so the tall glyph
// never bleeds into its neighbours.

import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme, settings } from "herdr";
import { W, H, FRAMES } from "./sprite.js";

const FRAME_MS = 220;
const FONT = "JetBrains Mono";
const CELL_MAX = 4;
const CELL_MIN = 2;
const PAD = 8;

// Layer order: later layers paint over earlier ones; cells never overlap, so it doesn't matter.
const LAYERS = ["p", "d", "l", "w", "k", "c", "b"];
const colors = (dark) => ({
  p: "#a374db",
  d: "#6f45a8",
  l: "#cdb0f2",
  w: dark ? "#f6f2fb" : "#ffffff",
  k: "#1c1a1f",
  c: "#f2a0c0",
  b: dark ? "#89c4f4" : "#5aa7e0",
});

// Each color's rows across frames: rows[c][y] = one string per frame, "█" where the pixel is c.
function build() {
  const rows = {};
  for (const c of LAYERS) {
    rows[c] = [];
    for (let y = 0; y < H; y++) {
      const perFrame = FRAMES.map((f) => f[y].replace(/./g, (ch) => (ch === c ? "█" : " ")).replace(/ +$/, ""));
      rows[c].push(perFrame.some((s) => s.length) ? perFrame : null);
    }
  }
  return rows;
}

export default class Octopus extends View {
  init() {
    this.rows = build();
    this.size = null;
  }

  render() {
    const t = theme();
    const palette = colors(Boolean(settings()?.dark));
    const width = this.size?.width ?? 0;
    const height = this.size?.height ?? 0;
    // As big as fits, up to 4px a pixel; in a narrow sidebar it shrinks, below 2px it hides.
    const cell = Math.min(CELL_MAX, Math.floor((width - PAD) / W));
    const fits = this.size && cell >= CELL_MIN && height >= H * cell;
    const sw = W * cell;
    const sh = H * cell;
    // Whole pixels: a half-pixel offset would antialias a seam between every glyph.
    const left = Math.floor((width - sw) / 2);
    const top = Math.floor((height - sh) / 2);
    const layer = (c) =>
      v_flex()
        .absolute()
        .left(left)
        .top(top)
        .w(sw)
        .h(sh)
        .text_color(palette[c])
        .font_family(FONT)
        .text_size(cell / 0.6)
        .line_height(`${cell}px`)
        .whitespace_nowrap()
        .children(
          this.rows[c].map((perFrame) =>
            div()
              .h(cell)
              .w(sw)
              .flex_none()
              .overflow_hidden()
              .when(Boolean(perFrame), (el) => el.frames(perFrame, FRAME_MS)),
          ),
        );
    return div()
      .id("root")
      .relative()
      .size_full()
      .overflow_hidden()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .on_size_change((size, cx) => {
        if (this.size?.width === size.width && this.size?.height === size.height) return;
        this.size = size;
        cx.notify();
      })
      .when(Boolean(fits), (el) => el.children(LAYERS.map(layer)));
  }
}
