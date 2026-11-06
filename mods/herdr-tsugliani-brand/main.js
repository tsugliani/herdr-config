// herdr-tsugliani-brand: the sidebar's top row (the `brand` block): Herdr's logo and
// name, search, and the sidebar toggle. From the shipped `workspace-chrome` (0.1.13),
// changed to leave room for the macOS window buttons at any zoom: they don't scale with
// Herdr's zoom, and the shipped row leaves 76px at any zoom, so below zoom 1 the logo
// slid under them.
import { View, div, image, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, window, shared, setShared, layout, settings } from "herdr";

const ICON = (name) => `mods/herdr-tsugliani-brand/${name}.svg`;

// The traffic lights don't scale with Herdr's zoom; room for them must grow as the zoom shrinks.
const zoom = () => Number(settings()?.zoom) || 1;
const lights = () => 76 / zoom();
// Their middle sits 23px down at any zoom; the row's own middle is at 23 zoomed px. Padding the
// top by twice the gap lines the two up (capped so the 26px buttons still fit the 46px row).
const drop = () => Math.min(20, Math.max(0, 2 * (23 / zoom() - 23)));

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? Math.ceil(lights()) : 44 });
}

export default class Brand extends View {
  button(id, label, action) {
    const t = theme();
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }
  render() {
    const t = theme();
    const collapsed = narrow();
    return h_flex().size_full().bg(t.chrome).pl(collapsed ? 6 : 14).pr(10).gap(4).items_center().text_size(13.5)
      .when(window()?.platform === "macos" && !window()?.fullscreen && !collapsed, el => el.pl(lights()).pt(drop()))
      .when(!collapsed, el => el.child(h_flex().flex_1().gap(8).items_center().child(image("frame/welcome/herdr.png").size(20).rounded(5)).child(div().font_semibold().text_color(t.foreground).child("Herdr"))))
      .when(!collapsed, el => el.child(this.button("search", svg(ICON("search")).size(15), () => run("mod.open", { name: "picker" }))))
      // On the macOS rail the traffic lights fill the row; the agents list's » unfolds it.
      .when(!(collapsed && window()?.platform === "macos"), el => el.child(this.button("sidebar-toggle", svg(ICON("sidebar")).size(15), toggleSidebar)));
  }
}
