// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known.
// herdr-tsugliani-spaces (mod.clone of the shipped `spaces`, 0.1.13) adds folders: inside a
// machine's section, named folders you make (the folder + in its header, or in the Spaces
// header when there's one section), fold (click), rename and delete (right-click), and drag spaces
// into (drop on the folder, or on a space in it) and out of (drop on a loose space, or on
// "Out of folder" while dragging). A worktree goes with its checkout. Each machine's folders
// live in a document on that machine's Herdr core (folders.js: DOC), so every device
// connected to it sees the same ones; folding is per screen. This list re-reads them all
// every POLL_MS in one `hc connect`, keeps them in shared state (CACHE) for its popups and
// the next start, and writes a change as read, change, write, again on a version conflict.
// The first read of a machine with no document moves its folders from the old shared list. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, machines, panes, run, openOverlay, closeOverlay, props, exec, hc, theme, shared, setShared, watchFolder, window, layout } from "herdr";
import { KEY as LEGACY, place as placeIn, newFolder, rename as renameFolder, remove as removeFolder, tag, inSection,
  fromDoc, toDoc, docParams, rpcInput, parseReplies, isConflict } from "./folders.js";

const NAME = "herdr-tsugliani-spaces";
const CACHE = "herdr-tsugliani-spaces.cache"; // { "<machine>" | "": { version, value } }
const POLL_MS = 4000;
const mkey = (m) => m ?? "";
const cache = () => shared(CACHE) ?? {};
const folders = () => Object.entries(cache()).flatMap(([k, c]) => fromDoc(c?.value, k || null));
const machineOf = (spaceId) => spaces().find((s) => s.id === spaceId)?.machine ?? null;

function setCache(m, version, value) {
  const c = cache()[mkey(m)];
  if (c && c.version === version && JSON.stringify(c.value) === JSON.stringify(value)) return;
  setShared(CACHE, { ...cache(), [mkey(m)]: { version, value } });
}

// Requests to the cores, all in one `hc connect`: replies by id.
async function rpc(requests) {
  const r = await exec("sh", ["-c", 'H=$(command -v hc || echo "$HOME/.local/bin/hc"); printf "%s" "$1" | "$H" connect', "sh", rpcInput(requests)]);
  return parseReplies(r.stdout);
}

// Each machine's document: [{ result: { value, version } } | { error } | undefined], in order.
async function readDocs(ms) {
  const replies = await rpc(ms.map((m, i) => ({ id: i + 1, method: "doc.get", params: docParams(m) })));
  return ms.map((_m, i) => replies.get(i + 1));
}

// Changes `m`'s folders: shown at once, then written over what the core has now, again if
// another device wrote first. Ends showing whatever the core holds.
// Machines with a change still being written: the regular read leaves them alone, so a
// read from just before the write can't briefly put the old folders back. A write whose task
// was cancelled never counts down, so a mark older than STUCK_MS stops counting: the regular
// read takes the machine back instead of leaving its folders stale until the mod reloads.
// Run edits from a popup before closing it: closing cancels its unfinished tasks.
const writing = new Map(); // machine -> { n, at }
const STUCK_MS = 60000;
const busy = (m) => { const w = writing.get(mkey(m)); return !!w && w.n > 0 && Date.now() - w.at < STUCK_MS; };
function mark(m, d) {
  const w = writing.get(mkey(m));
  const n = Math.max(0, (w && Date.now() - w.at < STUCK_MS ? w.n : 0) + d);
  writing.set(mkey(m), { n, at: Date.now() });
}

async function edit(m, change) {
  mark(m, 1);
  const c = cache()[mkey(m)];
  setShared(CACHE, { ...cache(), [mkey(m)]: { version: c?.version ?? 0, value: toDoc(change(fromDoc(c?.value, m)), m) } });
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const [got] = await readDocs([m]);
      if (!got?.result) break;
      const value = toDoc(change(fromDoc(got.result.value, m)), m);
      const set = (await rpc([{ id: 1, method: "doc.set", params: docParams(m, { value, version: got.result.version }) }])).get(1);
      if (set?.result) { setCache(m, set.result.version, value); return; }
      if (!isConflict(set)) break;
    }
    const [got] = await readDocs([m]);
    if (got?.result) setCache(m, got.result.version, got.result.value);
  } catch {} finally {
    mark(m, -1);
  }
}

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

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

export default class Spaces extends View {
  init(_props, cx) {
    this.popup = props()?.popup ?? null;
    if (this.popup) return this.initPopup(cx);
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
    for (const state of Object.values(this.reconnecting)) state.busy = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.foldersFolded = new Set(JSON.parse(localStorage.getItem("folders.folded") ?? "[]"));
    this.migrating = new Set();
    this.poll(cx);
    cx.timer.every(POLL_MS, (cx) => this.poll(cx));
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now)) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  orderingDue(now) {
    return this.ordering && now - this.ordering.at >= 1000
      && this.ordering.machines.every(name => machines().some(m => m.name === name && m.layout === "ready"));
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null }));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    // Simulate the batch so later indexes include earlier moves. An attempted
    // write can lose a sync conflict: allow the echo to settle before retrying.
    const order = sp.map(w => w.id);
    const target = out.map(r => r.w.id);
    const key = JSON.stringify([order, target, machines()]);
    if (order.every((id, i) => id === target[i])) {
      this.ordering = null;
    } else if (this.ordering?.key !== key || this.orderingDue(Date.now())) {
      const moved = new Set();
      this.ordering = { key, at: Date.now(), machines: [] };
      for (let i = 0; i < out.length; i++) {
        const from = order.indexOf(out[i].w.id);
        if (from === i) continue;
        run("space.move", { id: out[i].w.id, index: i + 1 });
        moved.add(out[i].w.machine ?? null);
        order.splice(i, 0, order.splice(from, 1)[0]);
      }
      this.ordering.machines = [...moved];
    }
    return out.filter(r => this.shown.has(r.w.id));
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    const draw = (r) => (collapsed ? this.compact(r, t) : this.row(r, t));
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => div().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(8).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    this.oneSection = !remote.length;
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : this.section(rows, null, t, collapsed, draw);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const folded = this.folded.has(m);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 2 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none())
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected && !rebuilt, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-folder-${m ?? "local"}`).flex_none().px(3).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .tooltip("New folder").on_click((_e, cx) => { cx.stop_propagation(); this.newFolder(m); })
            .child(svg("mods/workspace-chrome/folder-plus.svg").size(12))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .child(svg("mods/workspace-chrome/plus.svg").size(12)).when(!collapsed, el => el.child("New space there"));
      if (!collapsed && rebuilt) return [head];
      return [head, ...(folded ? [] : mine.length ? this.section(mine, m, t, collapsed, draw) : [loading(m) ? loadingRow(m) : empty])];
    });
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  row({ w, i, g, tree, folder, indent }, t) {
    const on = w.active;
    const fromIndex = this.pressed === null ? -1 : spaces().findIndex(s => s.id === this.pressed);
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .when(Boolean(indent), (el) => el.pl(22))
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === w.id && this.pressed !== w.id, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(fromIndex < i, line => line.bottom(0))
          .when(fromIndex > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = w.id;
        this.over = w.id;
        this.dragging = false;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces().find(s => s.id === this.pressed);
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? w.id : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          if (over !== this.pressed) this.dragging = true;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        this.dragging = false;
        if (from !== null && over === w.id && from !== w.id) {
          this.join(from, folder ?? null);
          const index = spaces().findIndex(s => s.id === w.id);
          if (index !== -1) run("space.move", { id: from, index: index + 1 });
        } else if (from === w.id) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .when(Boolean(tree), el => el.pl(22).child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(t.dim)))
          .when(!tree, el => el.child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?")))
          .child(div().flex_shrink(0).max_w(150).truncate().text_color(t.foreground).child(w.name))
          .child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1()),
      );
  }

  // ── folders ──────────────────────────────────────────────────────────────────────────

  // One machine's rows: its folders (header, then members unless folded), then loose spaces.
  // The rail stays flat.
  section(rows, m, t, collapsed, draw) {
    if (collapsed) return rows.map(draw);
    const mine = inSection(folders(), m);
    const tagged = tag(rows, mine);
    const out = [];
    for (const f of mine) {
      const members = tagged.filter((r) => r.folder === f.id);
      const open = !this.foldersFolded.has(f.id);
      out.push(this.folderHead(f, members, open, m, t));
      if (open) out.push(...(members.length ? members.map((r) => draw({ ...r, indent: true })) : [this.folderEmpty(f, m, t)]));
    }
    out.push(...tagged.filter((r) => !r.folder).map(draw));
    // Dragging a space out of its folder: somewhere to drop it, even with no loose spaces.
    const source = spaces().find((s) => s.id === this.pressed);
    const dragged = this.dragging && source && (source.machine ?? null) === m && tagged.find((r) => r.w.id === source.id)?.folder;
    if (dragged) out.push(div().id(`folder-out-${m ?? "local"}`).h(26).flex_none().mx(2).px(8).flex().items_center().rounded(7)
      .border_1().border_color(this.over === `out:${m ?? ""}` ? t.accent : t.border).text_size(11.5).text_color(t.dim)
      .on_mouse_move((_e, cx) => { const k = `out:${m ?? ""}`; if (this.pressed !== null && this.over !== k) { this.over = k; cx.notify(); } })
      .on_mouse_up("left", (_e, cx) => { if (this.pressed !== null) this.join(this.pressed, null); this.endDrag(cx); })
      .child("Out of folder"));
    return out;
  }

  // Hovering it with a dragged space of the same machine makes it the drop target; letting
  // go there puts the space in folder `f`.
  dropTarget(el, f, m) {
    const target = `folder:${f.id}`;
    return el
      .on_mouse_move((_e, cx) => {
        const source = spaces().find((s) => s.id === this.pressed);
        const ok = source && (source.machine ?? null) === (m ?? null);
        if (this.pressed !== null && ok && this.over !== target) { this.over = target; this.dragging = true; cx.notify(); }
      })
      .on_mouse_up("left", (_e, cx) => {
        if (this.pressed === null) return;
        if (this.over === target) this.join(this.pressed, f.id);
        this.endDrag(cx);
      });
  }

  endDrag(cx) {
    this.pressed = null; this.over = null; this.dragging = false;
    cx.notify();
  }

  folderEmpty(f, m, t) {
    const dropping = this.pressed !== null && this.over === `folder:${f.id}`;
    return this.dropTarget(div().id(`folder-empty-${f.id}`).h(26).flex_none().pl(30).pr(8).flex().items_center().rounded(7)
      .border_1().border_color(dropping ? t.accent : "#00000000").text_size(11.5).text_color(t.dim), f, m)
      .child("Drag spaces here");
  }

  folderHead(f, members, open, m, t) {
    const target = `folder:${f.id}`;
    const dropping = this.pressed !== null && this.over === target;
    const hasActive = members.some((r) => r.w.active);
    const urgent = members.map((r) => r.w.status).find((s) => s === "blocked") ?? members.map((r) => r.w.status).find((s) => s === "done");
    return this.dropTarget(h_flex().id(`folder-${f.id}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7)
      .text_size(12.5).text_color(t.muted).cursor_pointer()
      .border_1().border_color(dropping ? t.accent : "#00000000")
      .when(!open && hasActive, (el) => el.bg(t.selected))
      .when(dropping, (el) => el.bg(t.hover))
      .when(!dropping, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground))), f, m)
      .on_click((_e, cx) => {
        open ? this.foldersFolded.add(f.id) : this.foldersFolded.delete(f.id);
        localStorage.setItem("folders.folded", JSON.stringify([...this.foldersFolded]));
        cx.notify();
      })
      .on_mouse_down("right", () => openOverlay({ mod: NAME, kind: "popup", width: 200, height: 84, props: { popup: { kind: "menu", id: f.id, machine: m ?? null } } }))
      .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim))
      .child(svg("mods/workspace-chrome/folder.svg").size(14).flex_none().text_color(t.accent))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(f.name))
      .when(Boolean(urgent) && !open, (el) => el.child(div().text_color(tone(t, urgent)).child(glyph(urgent))))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(String(members.length)));
  }

  // This device's core and every machine whose layout is up, in one `hc connect`.
  poll(cx) {
    if (this.polling) return;
    this.polling = true;
    const ms = [null, ...machines().filter((x) => x.name && x.layout === "ready").map((x) => x.name)];
    cx.spawn(async () => {
      try {
        const got = await readDocs(ms);
        ms.forEach((m, i) => {
          const r = got[i]?.result;
          if (!r || busy(m)) return;
          if (r.version === 0) this.migrate(m);
          else setCache(m, r.version, r.value);
        });
      } catch {}
      this.polling = false;
    });
  }

  // Once per machine: its folders from the old shared list go to its core, only if no
  // device wrote there yet (version 0); then they leave the old list.
  migrate(m) {
    const old = inSection(shared(LEGACY) ?? [], m);
    if (!old.length || this.migrating.has(mkey(m))) return;
    this.migrating.add(mkey(m));
    const value = toDoc(old, m);
    rpc([{ id: 1, method: "doc.set", params: docParams(m, { value, version: 0 }) }]).then((replies) => {
      const set = replies.get(1);
      if (set?.result) setCache(m, set.result.version, value);
      if (set?.result || isConflict(set)) setShared(LEGACY, (shared(LEGACY) ?? []).filter((f) => (f.machine ?? null) !== (m ?? null)));
      this.migrating.delete(mkey(m));
    }).catch(() => this.migrating.delete(mkey(m)));
  }

  join(id, folderId) {
    edit(machineOf(id), (list) => placeIn(list, id, folderId));
  }

  newFolder(m) {
    const id = `f${Date.now().toString(36)}`;
    edit(m ?? null, (list) => newFolder(list, m ?? null, id).list);
    this.openRename(id, m ?? null);
  }

  openRename(id, machine) {
    openOverlay({ mod: NAME, kind: "dialog", width: 360, height: 196, props: { popup: { kind: "rename", id, machine } } });
  }

  // ── the folder's menu and rename dialog (this mod, opened as an overlay) ──────────────

  initPopup(cx) {
    if (this.popup.kind !== "rename") return;
    const f = folders().find((x) => x.id === this.popup.id);
    this.text = f?.name ?? "";
    this.input = InputState.new({ value: this.text });
    if (this.text) this.input.set_selected_range({ start: 0, end: this.text.length });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
    this.input.on("submit", () => this.submitRename());
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
  }

  // Written before the dialog closes: closing cancels its unfinished tasks.
  submitRename() {
    if (this.saving) return;
    this.saving = true;
    const overlay = props().overlay, { id, machine } = this.popup;
    edit(machine ?? null, (list) => renameFolder(list, id, this.text)).finally(() => closeOverlay(overlay));
  }

  // The same look as Herdr's own prompt and menus.
  renderPopup() {
    const t = theme(), p = this.popup, close = () => closeOverlay(props().overlay);
    if (p.kind === "menu") {
      const item = (id, label, color, act) => h_flex().id(id).h(32).px(10).items_center().rounded(6).text_size(12.5)
        .text_color(color).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => { Promise.resolve(act()).finally(close); }).child(label);
      return v_flex().id("folder-menu").size_full().p(5).gap(2).bg(t.popover)
        .child(item("fm-rename", "Rename…", t.foreground, () => this.openRename(p.id, p.machine ?? null)))
        .child(item("fm-delete", "Delete folder", t.blocked, () => edit(p.machine ?? null, (list) => removeFolder(list, p.id))));
    }
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    return v_flex().id("folder-rename").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { close(); cx.stop_propagation(); } })
      .w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child("Rename folder"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().pt(16).pb(7).text_size(11.5).text_color(t.dim).child("Name"))
      .child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(t.accent).bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(h_flex().pt(20).gap(8).justify_end()
        .child(button("fr-cancel", "Cancel", false, close))
        .child(button("fr-save", "Save", true, () => this.submitRename())));
  }

  compact({ w, i }, t) {
    return h_flex()
      .id(`space-${w.id}`)
      .h(26)
      .flex_none()
      .justify_center()
      .gap(4)
      .when(w.active, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().text_color(tone(t, w.status)).child(glyph(w.status)));
  }

  render() {
    if (this.popup) return this.renderPopup();
    const t = theme();
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    const list = this.grouped(t, collapsed);
    const activeMachine = sp.find((s) => s.active)?.machine ?? null;
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).gap(2).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(!collapsed, el => el.child(div().flex_1().child("Spaces")))
        .when(!collapsed && this.oneSection, el => el.child(div().id("folder-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip("New folder").on_click(() => this.newFolder(activeMachine)).child(svg("mods/workspace-chrome/folder-plus.svg").size(14))))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("space.new")).child(svg("mods/workspace-chrome/plus.svg").size(14))))
      .child(v_flex().id("space-list").flex_1().min_h(0).px(8).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => this.endDrag(cx))
        // A release outside the list never reaches it: leaving the list ends the drag, so
        // nothing stays half-dragged until the next click.
        .on_hover((hovered, cx) => { if (!hovered && this.pressed !== null) this.endDrag(cx); })
        .children(list));
  }
}
