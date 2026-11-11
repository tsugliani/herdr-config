// session-bar: a bottom bar of chips for any Herdr layout. Left: the focused pane's folder,
// its branch, and git chips (↑ to push, ↓ to pull, changed, staged, conflicts, stashes).
// Right: Claude Code's usage. The account's 5h and 7d limits, whatever pane is focused,
// each a bar with a tick for the time already passed, green / amber / red at 70 and 90
// percent, and while the focused pane runs Claude Code also its model, effort and
// context (ctx) meter. The numbers come from claude-statusline.sh in this folder, which
// Claude Code runs as its status line command: it writes <terminal>.json and limits.json
// under ~/.local/state/herdr-session-bar/, and the bar watches that folder (re-read every
// 30 s too, in case the watch ends). A Claude Code pane on another machine (zboxdev/t1g)
// reads t1g.json there, every few seconds while focused, as no folder watch reaches it;
// the limits are the freshest limits.json of this computer and the machines. Resting the
// pointer on the Claude chips opens a card with every number and reset time; a reading
// older than 15 min is dimmed. The session's writing speed (tok/s) follows the model: an
// estimate per reply, worked out by the script, with the session average in the card.
// Chips act: changed opens the Changes panel, ↑ ↓ open a push / pull menu. Colors come
// from theme().
// From github.com/cybertron288/herdr-mods (session-bar, 34e7c33, MIT: see LICENSE), renamed,
// with the changed chip opening this layout's Changes panel instead of filetree, and the
// Claude side fed by the status line instead of a plugin and drawn after
// github.com/nozikov/herdr-usage-limits (MIT).
import { View, div, svg } from "gpui-kit";
import { HoverCard, v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, home, layout, props, run, notify, openOverlay, closeOverlay, machines } from "herdr";
import { modelName, windowLabel, meterView, ago, isStale, speedView } from "./usage.js";

const NAME = "herdr-tsugliani-session-bar";
const ICON = (name) => `mods/${NAME}/${name}.svg`;
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
const BAR_W = 46, CARD_W = 330, CARD_BAR_W = 110;
const CARD_OPEN_MS = 350, CARD_CLOSE_MS = 300; // passing over the bar doesn't flash the card; the pointer can cross to it
const infoDir = () => `${home()}/.local/state/herdr-session-bar`;
// The same folder on another machine, from its home (where exec starts there).
const REMOTE_INFO = ".local/state/herdr-session-bar";
const REMOTE_MS = 4000, LIMITS_MS = 30000;
// "zboxdev/t1g" -> { machine: "zboxdev", id: "t1g" }; a terminal here has no machine.
function splitTerminal(terminal) {
  const at = terminal?.indexOf("/") ?? -1;
  return at < 0 ? { machine: null, id: terminal ?? null } : { machine: terminal.slice(0, at), id: terminal.slice(at + 1) };
}
// A file of the folder on `machine`, parsed, or null.
async function readThere(machine, name) {
  try {
    const r = await exec("cat", [`${REMOTE_INFO}/${name}`], { on: machine, timeout: 10000 });
    return r.code === 0 ? JSON.parse(r.stdout) : null;
  } catch { return null; }
}
const validLimits = (l) => (Array.isArray(l?.meters) && Number.isFinite(l?.at) ? l : null);
// cc-model-router (a Claude Code plugin) writes its switch here, one file per terminal.
const routerDir = () => `${home()}/.local/state/herdr-model-router`;

function where() {
  const f = focused(), space = spaces().find((s) => s.active);
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd ?? f?.cwd ?? space?.folder ?? null, on, pane, terminal: pane?.terminal ?? f?.terminal ?? null, space };
}

const folderName = (cwd) => (!cwd ? null : cwd === home() ? "~" : cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "/");

const isClaude = (pane) => Boolean(pane && (pane.app === "claude-code" || pane.program?.key === "claude"));

// Corners follow the shown layout's pane frame: square in a flush layout, rounded in a card one.
function frameRadius() {
  let pane = null;
  const walk = (n) => {
    if (!n || pane) return;
    if (n.content?.tab && n.content.pane) pane = n.content.pane;
    for (const c of n.children ?? []) walk(c);
  };
  try { walk(layout()); } catch {}
  const r = Number(pane?.radius ?? 6);
  return Math.max(0, Math.min(6, Number.isFinite(r) ? r : 6));
}

function parseStatus(stdout) {
  const g = { branch: null, upstream: "", ahead: 0, behind: 0, changed: 0, staged: 0, untracked: 0, conflicts: 0 };
  for (const rec of stdout.split("\0")) {
    if (rec.startsWith("## ")) {
      const body = rec.slice(3);
      g.branch = body.startsWith("HEAD (no branch)") ? "detached" : body.match(/^(?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.|\s|$)/)?.[1] ?? body;
      g.upstream = body.match(/\.\.\.(\S+)/)?.[1] ?? "";
      g.ahead = Number(body.match(/ahead (\d+)/)?.[1] ?? 0);
      g.behind = Number(body.match(/behind (\d+)/)?.[1] ?? 0);
      continue;
    }
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    g.changed++;
    if (xy === "??") { g.untracked++; continue; }
    if (/U/.test(xy) || xy === "AA" || xy === "DD") { g.conflicts++; continue; }
    if (xy[0] !== " ") g.staged++;
  }
  return g;
}

// Finds the layout block that shows `mod` and makes it visible: selects it in every stack
// on the way and shows every node above it. False when the layout has no such block.
function revealMod(mod) {
  const path = [];
  const walk = (n) => {
    if (!n) return false;
    path.push(n);
    if (n.content?.mod === mod) return true;
    for (const c of n.children ?? []) if (walk(c)) return true;
    path.pop();
    return false;
  };
  let found = false;
  try { found = walk(layout()); } catch {}
  if (!found) return false;
  path.forEach((n, i) => {
    if (n.type === "stack" && path[i + 1]?.id) run("layout.select", { stack: n.id, child: path[i + 1].id });
    if (i > 0 && n.id) run("layout.show", { id: n.id });
  });
  return true;
}

export default class SessionBar extends View {
  init(_props, cx) {
    this.popup = props()?.popup ?? null;
    if (this.popup) return;
    this.git = null; this.info = null; this.limits = null; this.width = 1000;
    this.localLimits = null; this.remoteLimits = {};
    cx.timer.every(8000, (cx) => this.refresh(cx));
    // Ticks, times to reset and staleness move with the clock.
    cx.timer.every(60000, (cx) => cx.notify());
    this.watchInfo(cx);
  }

  // ── git ──────────────────────────────────────────────────────────────────────────────
  refresh(cx) {
    const { cwd, on } = where();
    if (!cwd) { this.git = null; return; }
    if (this.loading) { this.again = true; return; }
    const key = JSON.stringify([cwd, on]);
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const g = (args) => exec("git", [...READ, ...args], { cwd, on });
        const top = await g(["rev-parse", "--show-toplevel"]).catch(() => null);
        if (top?.code !== 0) { if (this.key === key) this.git = null; return; }
        const [status, stash] = await Promise.all([
          g(["status", "--porcelain=v1", "-z", "-b", "--untracked-files=normal"]),
          g(["rev-list", "--walk-reflogs", "--count", "refs/stash"]).catch(() => null),
        ]);
        if (this.key !== key || status.code !== 0) return;
        this.git = { ...parseStatus(status.stdout), stash: stash?.code === 0 ? Number(stash.stdout.trim()) || 0 : 0, top: top.stdout.trim(), cwd, on };
        this.watchRepo(this.git.top, on, cx);
      } catch { if (this.key === key) this.git = null; }
      finally {
        this.loading = false;
        if (this.again) { this.again = false; this.refresh(cx); }
        cx.notify();
      }
    });
  }

  watchRepo(top, on, cx) {
    if (on || this.watched === top) return;
    this.watched = top;
    cx.spawn(async (cx) => {
      try { while (this.watched === top) { await watchFolder(top); if (this.watched === top) this.refresh(cx); } }
      catch { if (this.watched === top) this.watched = null; }
    });
  }

  // ── Claude, from claude-statusline.sh ────────────────────────────────────────────────
  watchInfo(cx) {
    cx.spawn(async (cx) => {
      try { await exec("mkdir", ["-p", infoDir(), routerDir()]); } catch {}
      this.readInfo(cx);
      try { for (;;) { await watchFolder(infoDir()); this.readInfo(cx); } } catch {}
    });
    cx.spawn(async (cx) => {
      try { await exec("mkdir", ["-p", routerDir()]); } catch {}
      try { for (;;) { await watchFolder(routerDir()); this.readInfo(cx); } } catch {}
    });
    // A remote session's file can't be watched: read it while its pane is focused.
    cx.timer.every(REMOTE_MS, (cx) => { const w = where(); if (splitTerminal(w.terminal).machine && isClaude(w.pane)) this.readInfo(cx); });
    // Every machine's limits, and this computer's folder again in case its watch ended.
    cx.timer.every(LIMITS_MS, (cx) => { this.readInfo(cx); this.readRemoteLimits(cx); });
    this.readRemoteLimits(cx);
    // Whether the plugin is enabled at all lives in Claude Code's settings.
    cx.timer.every(30000, (cx) => this.readPlugin(cx));
    this.readPlugin(cx);
  }

  readPlugin(cx) {
    cx.spawn(async (cx) => {
      let enabled = null;
      try {
        const plugins = JSON.parse((await readTextFile(`${home()}/.claude/settings.json`)) ?? "{}").enabledPlugins ?? {};
        const key = Object.keys(plugins).find((k) => k.startsWith("cc-model-router@"));
        enabled = key ? plugins[key] === true : null;
      } catch {}
      if (enabled !== this.routerPlugin) { this.routerPlugin = enabled; cx.notify(); }
    });
  }

  // limits.json holds the account's limits from whichever session reported last, so they
  // show whatever pane is focused; <terminal>.json is the focused Claude Code session's own.
  // A pane on another machine reads its own file there; the router is this computer's only.
  readInfo(cx) {
    const { terminal, pane } = where();
    const { machine, id } = splitTerminal(terminal);
    const own = id && isClaude(pane) ? id : null;
    cx.spawn(async (cx) => {
      const read = async (path) => { try { return JSON.parse((await readTextFile(path)) ?? "null"); } catch { return null; } };
      const limits = await read(`${infoDir()}/limits.json`);
      const info = !own ? null : machine ? await readThere(machine, `${own}.json`) : await read(`${infoDir()}/${own}.json`);
      const router = own && !machine ? await read(`${routerDir()}/${own}.json`) : null;
      this.localLimits = validLimits(limits);
      this.pickLimits();
      if (where().terminal === terminal) { this.info = info; this.router = router?.ended ? null : router; }
      cx.notify();
    });
  }

  // Each connected machine's limits.json; one round at a time.
  readRemoteLimits(cx) {
    if (this.readingRemote) return;
    const names = machines().filter((m) => m.name && m.layout === "ready").map((m) => m.name);
    if (!names.length) { this.remoteLimits = {}; this.pickLimits(); return; }
    this.readingRemote = true;
    cx.spawn(async (cx) => {
      try {
        const got = await Promise.all(names.map((m) => readThere(m, "limits.json")));
        this.remoteLimits = Object.fromEntries(names.map((m, i) => [m, validLimits(got[i])]));
        this.pickLimits();
        cx.notify();
      } finally { this.readingRemote = false; }
    });
  }

  // The account's limits: the freshest report of any machine.
  pickLimits() {
    this.limits = [this.localLimits, ...Object.values(this.remoteLimits)].filter(Boolean)
      .reduce((best, l) => (!best || l.at > best.at ? l : best), null);
  }

  // cc-model-router for the focused Claude Code pane: the plugin's switch in Claude Code's
  // settings, then that session's own /router on|off. Null when the plugin isn't installed.
  routerState() {
    if (this.routerPlugin === null || this.routerPlugin === undefined) return null;
    if (!this.routerPlugin) return { on: false, word: "disabled", label: "cc-model-router plugin is disabled in Claude Code" };
    const r = this.router;
    if (!r) return { on: true, word: "on", label: "cc-model-router is enabled. This session reports its state after it restarts" };
    if (!r.on) return { on: false, word: "off", label: "Router off in this session · /router on turns it on" };
    return { on: true, word: "on", label: r.model ? `Router on · picked ${modelName(r.model)}${r.tier ? ` for a ${r.tier} prompt` : ""}` : "Router on · picks the model for each prompt" };
  }

  // ── actions ──────────────────────────────────────────────────────────────────────────
  openChanged() {
    if (!revealMod("herdr-tsugliani-changes")) run("pane.split", { direction: "right", mod: "herdr-tsugliani-changes" });
  }

  openPopup(kind, height) {
    openOverlay({ mod: NAME, kind: "popup", width: 280, height, props: { popup: { kind, git: this.git } } });
  }

  // ── drawing ──────────────────────────────────────────────────────────────────────────
  chip(id, t, R, { icon, iconColor, color, tip, onClick }, ...kids) {
    return h_flex().id(id).h(20).px(7).gap(5).flex_none().items_center().rounded(R)
      .text_size(11.5).text_color(color ?? t.muted)
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .when(Boolean(onClick), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { onClick(cx); cx.notify(); }))
      .when(Boolean(icon), (el) => el.child(svg(ICON(icon)).size(11).flex_none().text_color(iconColor ?? color ?? t.dim)))
      .children(kids.filter((k) => k !== null && k !== undefined && k !== ""));
  }

  // Green, amber, red by level; a calm context meter keeps its own cyan.
  levelColor(t, v) {
    return v.level === "hot" ? t.ansi1 : v.level === "warn" ? t.ansi3 : v.label === "ctx" ? t.ansi6 ?? t.accent : t.ansi2;
  }

  // A limit's number always wears its level, green included; the context's only once warm.
  numberColor(t, v) {
    return v.expired ? t.dim : v.label === "ctx" && v.level === "ok" ? t.foreground : this.levelColor(t, v);
  }

  // The bar is how much is used; the tick, how much of the window's time has passed.
  track(t, v, w = BAR_W, h = 4) {
    return div().relative().w(w).h(h).rounded(2).flex_none().bg(t.raised)
      .child(div().absolute().left(0).top(0).h(h).rounded(2).w(Math.max(v.fill > 0 ? 2 : 0, Math.round(w * v.fill))).bg(this.levelColor(t, v)))
      .when(v.tick != null, (el) => el.child(div().absolute().top(-2).left(Math.round(w * v.tick)).w(1).h(h + 4).bg(t.foreground).opacity(0.75)));
  }

  cardRow(t, v) {
    return h_flex().id(`sb-card-${v.label}`).gap(8).items_center()
      .when(Boolean(v.hint), (el) => el.tooltip(v.hint))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(v.long))
      .child(this.track(t, v, CARD_BAR_W, 5))
      .child(div().w(36).flex_none().text_right().whitespace_nowrap().text_color(this.numberColor(t, v)).child(v.brief))
      .child(div().w(48).flex_none().text_right().whitespace_nowrap().text_size(11).text_color(t.dim).child(v.left));
  }

  // Everything known, on hover: this session, then the account's limits and their resets.
  card(t, session, limits, router, stale) {
    const i = session, nowMs = Date.now(), at = this.limits?.at ?? i?.at ?? null;
    return v_flex().id("sb-card").w(CARD_W).p(12).gap(9).rounded(8).border(1).border_color(t.border).bg(t.popover ?? t.surface).shadow_lg()
      .text_size(12).text_color(t.foreground)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(10.5).font_semibold().text_color(t.dim).child("CLAUDE CODE"))
        .when(at != null, (el) => el.child(div().text_size(11).text_color(stale ? t.ansi3 : t.dim).child(`updated ${ago(at, nowMs)}`))))
      .when(Boolean(i), (el) => el
        .child(h_flex().gap(8).items_center().tooltip(i.model ?? "")
          .child(svg(ICON("sparkles")).size(13).flex_none().text_color(t.ansi3))
          .child(div().font_medium().child(modelName(i.model)))
          .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child([i.effort, windowLabel(i.window) && `${windowLabel(i.window)} context`].filter(Boolean).join(" · "))))
        .when(Boolean(router), (e) => e.child(div().text_size(11).text_color(t.dim).child(router.label)))
        .when(Boolean(i.speedView), (e) => e.child(h_flex().id("sb-card-speed").gap(8).items_center()
          .tooltip("Estimated per reply: output tokens over the time waiting for it, first token and thinking included. Replies under 100 tokens are left out.")
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child("Speed"))
          .child(div().flex_none().whitespace_nowrap().child(i.speedView.card)))
          .child(div().text_size(11).text_color(t.dim).child(i.speedView.detail)))
        .children(i.views.map((v) => this.cardRow(t, v)))
        .child(div().h(1).flex_none().bg(t.border)))
      .when(limits.length > 0, (el) => el.child(v_flex().gap(6).opacity(stale ? 0.55 : 1).children(limits.map((v) => this.cardRow(t, v)))))
      .when(limits.length === 0, (el) => el.child(div().text_size(11).text_color(t.dim).child("Limits appear after Claude's first reply")))
      .child(div().text_size(10.5).text_color(t.dim).child("Bar: used · tick: time passed · from Claude Code's status line"));
  }

  renderPopup() {
    const t = theme(), p = this.popup, close = () => closeOverlay(props().overlay);
    const item = (id, label, sub, act) => v_flex().id(id).px(10).py(6).gap(1).rounded(frameRadius()).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(() => { close(); act(); }).child(div().text_size(12.5).text_color(t.foreground).child(label)).when(Boolean(sub), (el) => el.child(div().text_size(11).text_color(t.dim).child(sub)));
    const gitRun = (args, doing, done) => {
      const g = p.git;
      notify({ title: `${doing}…`, level: "info", timeout: 1500 });
      exec("git", args, { cwd: g.cwd, on: g.on })
        .then((r) => notify(r.code === 0 ? { title: done, body: (r.stderr || r.stdout).trim().split("\n").pop(), level: "success", timeout: 3000 } : { title: `${doing} failed`, body: (r.stderr || r.stdout).trim(), level: "error", timeout: 6000 }))
        .catch((e) => notify({ title: `${doing} failed`, body: String(e?.message ?? e), level: "error", timeout: 6000 }));
    };
    const g = p.git, up = g.upstream || "its upstream";
    return v_flex().id("sb-git").size_full().p(5).bg(t.popover ?? t.surface).children([
      g.ahead ? item("sb-push", `Push ${g.ahead} commit${g.ahead === 1 ? "" : "s"}`, `to ${up}`, () => gitRun(["push"], "Pushing", "Pushed")) : null,
      g.behind ? item("sb-pull", `Pull ${g.behind} commit${g.behind === 1 ? "" : "s"}`, `from ${up}`, () => gitRun(["pull", "--ff-only"], "Pulling", "Pulled")) : null,
      item("sb-fetch", "Fetch", "update ↑ ↓ from the remote", () => gitRun(["fetch"], "Fetching", "Fetched")),
    ].filter(Boolean));
  }

  render(cx) {
    if (this.popup) return this.renderPopup();
    const t = theme(), w = where();
    const key = JSON.stringify([w.cwd, w.on]);
    if (key !== this.key) { this.key = key; this.git = null; this.refresh(cx); }
    if (w.terminal !== this.infoFor) { this.infoFor = w.terminal; this.info = null; this.readInfo(cx); }
    const R = frameRadius(), g = this.git, i = this.info, wide = this.width >= 900, mid = this.width >= 620;
    const ink = t.accent, name = folderName(w.cwd);
    const branch = g?.branch ?? w.pane?.branch ?? w.space?.branch ?? null;
    const chip = (id, opts, ...kids) => this.chip(id, t, R, opts, ...kids);
    const left = [
      name ? h_flex().id("sb-folder").gap(6).flex_none().items_center().tooltip(w.cwd ?? "").child(svg(ICON("folder")).size(13).text_color(ink)).child(div().max_w(180).truncate().child(name)) : null,
      branch ? chip("sb-branch", { icon: "git-branch", iconColor: ink, color: t.foreground, tip: g?.upstream ? `Tracks ${g.upstream} · click to copy` : "Click to copy", onClick: (cx) => { cx.write_to_clipboard(branch); notify({ title: "Copied", body: branch, timeout: 1500 }); } }, div().max_w(wide ? 260 : 160).truncate().child(branch)) : null,
      g?.ahead ? chip("sb-ahead", { icon: "arrow-up", color: t.ansi6, tip: `${g.ahead} to push`, onClick: () => this.openPopup("git", g.behind ? 3 * 44 + 10 : 2 * 44 + 10) }, String(g.ahead)) : null,
      g?.behind ? chip("sb-behind", { icon: "arrow-down", color: t.ansi4, tip: `${g.behind} to pull`, onClick: () => this.openPopup("git", g.ahead ? 3 * 44 + 10 : 2 * 44 + 10) }, String(g.behind)) : null,
      g?.changed ? chip("sb-changed", { icon: "pencil", color: t.ansi11 ?? t.ansi3, tip: `${g.changed} uncommitted (${g.untracked} untracked) · open Changes`, onClick: () => this.openChanged() }, String(g.changed)) : null,
      g?.staged && mid ? chip("sb-staged", { icon: "plus", color: t.ansi2, tip: `${g.staged} staged` }, String(g.staged)) : null,
      g?.conflicts ? chip("sb-conflicts", { icon: "triangle-alert", color: t.ansi1, tip: `${g.conflicts} with conflicts · open Changes`, onClick: () => this.openChanged() }, String(g.conflicts)) : null,
      g?.stash && mid ? chip("sb-stash", { icon: "archive", color: t.dim, tip: `${g.stash} stash${g.stash === 1 ? "" : "es"}` }, String(g.stash)) : null,
    ].filter(Boolean);
    // Right: this session (model, ctx) while the pane runs Claude Code, then the account's
    // limits whatever is focused. A narrow bar drops the tracks first, then the labels.
    const nowSec = Math.floor(Date.now() / 1000);
    const session = i && isClaude(w.pane) ? { ...i, views: (i.meters ?? []).filter((m) => m.label === "ctx").map((m) => meterView(m, nowSec)), speedView: speedView(i.speed) } : null;
    const limits = (this.limits?.meters ?? []).map((m) => meterView(m, nowSec));
    const stale = limits.length > 0 && isStale(this.limits.at, Date.now());
    const router = isClaude(w.pane) && !splitTerminal(w.terminal).machine ? this.routerState() : null;
    const meterChip = (v) => chip(`sb-m-${v.label}`, {},
      mid ? div().text_color(t.dim).child(v.label) : null,
      wide ? this.track(t, v) : null,
      div().whitespace_nowrap().text_color(this.numberColor(t, v)).child(mid ? v.text : v.brief));
    const sessionChips = [
      router ? chip("sb-router", { icon: "route", iconColor: router.on ? t.ansi2 : t.dim, color: router.on ? t.foreground : t.dim },
        div().child("Router"), div().text_color(router.on ? t.ansi2 : t.dim).child(router.word)) : null,
      session ? chip("sb-model", { icon: "sparkles", iconColor: t.ansi3, color: t.foreground },
        div().child(modelName(session.model)),
        mid ? div().text_color(t.dim).child([session.effort, wide ? windowLabel(session.window) : null].filter(Boolean).join(" · ")) : null) : null,
      session?.speedView && mid ? chip("sb-speed", { color: t.muted }, div().whitespace_nowrap().child(session.speedView.bar)) : null,
      ...(session?.views ?? []).map(meterChip),
    ].filter(Boolean);
    const limitChips = limits.map(meterChip);
    const group = h_flex().id("sb-claude").gap(4).items_center().flex_none()
      .children(sessionChips)
      .when(sessionChips.length > 0 && limitChips.length > 0, (el) => el.child(div().w(1).h(14).flex_none().bg(t.border)))
      .when(limitChips.length > 0, (el) => el.child(h_flex().gap(4).items_center().flex_none().opacity(stale ? 0.55 : 1).children(limitChips)));
    const right = sessionChips.length + limitChips.length === 0 ? null
      : HoverCard.new("sb-card-hover").anchor("bottom_right").open_delay(CARD_OPEN_MS).close_delay(CARD_CLOSE_MS)
        .trigger(group)
        .content(this.card(t, session, limits, router, stale));
    return h_flex().id(NAME).size_full().px(14).gap(8).items_center().overflow_hidden().bg(t.chrome).border_t(1).border_color(t.border).text_size(12).text_color(t.muted)
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 8) { this.width = size.width; cx.notify(); } })
      .children(left)
      .child(div().flex_1().min_w(8))
      .when(Boolean(right), (el) => el.child(right));
  }
}
