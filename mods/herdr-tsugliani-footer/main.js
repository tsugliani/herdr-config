// herdr-tsugliani-footer: the sidebar's footer (the `sidebar-footer` block), one row:
// Settings (with the accent dot when an app update is ready), and Add machine as a "+" at
// its right end, named by its tooltip. From the shipped `workspace-chrome` (0.1.13), whose
// footer stacks the two as rows. The collapsed rail has room for one icon: Settings.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, updates, layout } from "herdr";

const ICON = (name) => `mods/herdr-tsugliani-footer/${name}.svg`;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, as the brand row's toggle sets it.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

export default class Footer extends View {
  render() {
    const t = theme();
    const collapsed = narrow();
    const settingsRow = h_flex().id("settings").flex_1().min_w(0).h(28).px(8).gap(9).items_center().rounded(8)
      .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
      .on_click(() => run("app.settings")).child(svg(ICON("settings")).size(14))
      .when(!collapsed, el => el.child("Settings"))
      .when(Boolean(updates().app.ready), el => el.child(div().size(6).rounded_full().bg(t.accent)));
    const addMachine = div().id("machine").size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip("Add machine")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => run("mod.open", { name: "machine-add" }))
      .child(svg(ICON("plus")).size(14));
    return h_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(8).gap(4).items_center().text_size(13)
      .child(settingsRow)
      .when(!collapsed, el => el.child(addMachine));
  }
}
