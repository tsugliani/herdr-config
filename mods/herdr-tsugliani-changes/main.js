import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, settings, run, setShared, shared } from "herdr";

// Where the panel last looked; kept while a mod pane (a diff tab) has the focus.
let last = null;

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  // A mod pane has no folder: a diff tab names its repo, else the space's terminals say where it is
  // (the space's own folder is where it was made, which can be another repo by now).
  if (pane && !pane.terminal) {
    if (last && last.space === space?.id) return last.where;
    const diff = pane.mod === "herdr-tsugliani-diff" ? shared("herdr-tsugliani-diff.last") : null;
    if (diff && (diff.on ?? null) === on) return { cwd: diff.root, on };
    const tabs = new Set((space?.tabs ?? []).map((t) => t.id));
    const term = panes().find((p) => p.tab === pane.tab && p.terminal && p.cwd) ?? panes().find((p) => tabs.has(p.tab) && p.terminal && p.cwd);
    if (term) return { cwd: term.cwd, on };
  }
  const where = { cwd: pane?.cwd || f?.cwd || space?.folder, on };
  last = { space: space?.id, where };
  return where;
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const MODES = [["working", "Uncommitted"], ["branch", "Branch"], ["history", "History"]];
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

// `--numstat -z` and `--name-status -z` of one diff, as the file list.
function parseRange(names, nums) {
  const stats = {};
  for (const entry of nums.split("\0")) {
    const [a, d, ...parts] = entry.split("\t");
    if (parts.length) stats[parts.join("\t")] = { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" };
  }
  const tokens = names.split("\0"), files = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const code = tokens[i][0], path = tokens[i + 1];
    if (!code) continue;
    const status = code === "A" ? "A" : code === "D" ? "D" : code === "U" ? "U" : "M";
    files.push({ path, status, fresh: false, ...(stats[path] ?? { add: 0, del: 0 }) });
  }
  return files;
}

// Files under their folders. A folder holding only one folder joins it on one row (e2e/scripts/).
function treeRows(files, folded) {
  const top = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    parts.pop();
    let node = top;
    for (const part of parts) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push(f);
  }
  const totals = (node) => {
    let add = 0, del = 0, count = node.files.length;
    for (const f of node.files) { add += f.add; del += f.del; }
    for (const child of node.dirs.values()) { const c = totals(child); add += c.add; del += c.del; count += c.count; }
    return { add, del, count };
  };
  const rows = [];
  const walk = (node, prefix, depth) => {
    for (const [first, start] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      let name = first, child = start;
      while (!child.files.length && child.dirs.size === 1) { const [n, c] = [...child.dirs][0]; name += `/${n}`; child = c; }
      const path = prefix + name;
      rows.push({ kind: "dir", path, name, depth, ...totals(child) });
      if (!folded.has(path)) walk(child, `${path}/`, depth + 1);
    }
    for (const file of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) rows.push({ kind: "file", file, depth });
  };
  walk(top, "", 0);
  return rows;
}

export default class GitChanges extends View {
  init(_props, cx) {
    this.files = []; this.message = ""; this.handle = cx.focus_handle();
    this.mode = store.get("mode") ?? "working"; this.tree = store.get("view") !== "list"; this.folded = new Set(); this.commits = []; this.refs = []; this.gen = 0;
    this.compare = "HEAD"; this.withWork = false; this.filter = "";
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.search = InputState.new({ placeholder: "Filter branches" });
    this.search.on("change", (_e, cx) => { this.filter = this.search.value(); cx.notify(); });
    this.search.on("submit", (_e, cx) => { const first = this.shownRefs()[0]; if (first) this.choose(first, cx); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  // The git command whose diff is shown, without its output options.
  range() {
    if (this.mode === "branch") {
      if (!this.base) return null;
      return this.withWork && this.compare === "HEAD" ? ["diff", this.mergeBase] : ["diff", `${this.base}...${this.compare}`];
    }
    if (this.mode === "history") return this.selected ? ["show", "--format=", "-m", "--first-parent", this.selected.hash] : null;
    return null;
  }

  // force: a switch the person made, which replaces any refresh still running.
  refresh(cx, force) {
    if (!force && (this.loading || this.busy)) return;
    const { cwd, on } = location(), context = key(), gen = ++this.gen;
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.open = null; this.commits = []; this.selected = null;
      this.base = null; this.compare = "HEAD"; this.withWork = false; this.picking = null; this.refs = []; this.ahead = null;
      this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.limited = false;
    }
    if (!cwd) return;
    const live = () => key() === context && this.gen === gen;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (!live()) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.commits = []; this.open = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const branch = await git(["branch", "--show-current"]);
        if (this.mode !== "working" && !this.base) this.base = await this.defaultBase(git, root);
        if (!live()) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.branch = branch.stdout.trim() || head.stdout.trim().slice(0, 7);
        let files = [];
        if (this.mode === "working") files = await this.loadWorking(git);
        else if (this.mode === "branch") files = await this.loadBranch(git);
        else files = await this.loadHistory(git);
        if (!live()) return;
        this.files = files; this.error = null;
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) this.open = null;
      } catch (e) { if (live()) { this.error = String(e).trim(); this.files = []; this.open = null; } }
      finally { if (this.gen === gen) this.loading = false; cx.notify(); }
    });
  }

  async defaultBase(git, root) {
    const saved = store.get(`base:${root}`);
    const remote = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    const named = remote.code === 0 ? remote.stdout.trim() : null;
    const candidates = [saved, named?.replace(/^origin\//, ""), named, "main", "master", "origin/main", "origin/master", "trunk", "develop"];
    for (const ref of candidates.filter(Boolean)) {
      if ((await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).code === 0) return ref;
    }
    return null;
  }

  async loadWorking(git) {
    const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
    if (status.code !== 0) throw new Error(status.stderr);
    const stats = {};
    const results = this.hasHead ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
    for (const result of results) {
      if (result.code !== 0) throw new Error(result.stderr);
      for (const entry of result.stdout.split("\0")) {
        const [a, d, ...parts] = entry.split("\t");
        if (!parts.length) continue;
        const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
        stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
      }
    }
    const files = [];
    const entries = status.stdout.split("\0").filter(Boolean);
    for (const entry of entries.slice(0, 1000)) {
      const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
      const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
      const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
      const stat = stats[path] ?? { add: 0, del: 0 };
      files.push({ path, status: s, fresh, ...stat });
    }
    this.limited = entries.length > 1000;
    return files;
  }

  async loadBranch(git) {
    if (!this.base) { this.ahead = null; throw new Error("No main or master branch: pick a base"); }
    const merge = await git(["merge-base", this.base, this.compare]);
    if (merge.code !== 0) throw new Error(`${this.base} and ${this.compare} share no history`);
    this.mergeBase = merge.stdout.trim();
    const counts = await git(["rev-list", "--left-right", "--count", `${this.base}...${this.compare}`]);
    const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number);
    this.ahead = ahead; this.behind = behind;
    return this.loadRange(git);
  }

  async loadHistory(git) {
    const log = await git(["log", "-n", "300", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ar%x1f%P%x1e"]);
    if (log.code !== 0) throw new Error(this.hasHead ? log.stderr : "No commits yet");
    // Commits on this branch that the base doesn't have get a mark.
    const own = new Set();
    if (this.base) {
      const r = await git(["rev-list", "-n", "300", `${this.base}..HEAD`]);
      if (r.code === 0) r.stdout.split("\n").filter(Boolean).forEach((h) => own.add(h));
    }
    this.commits = log.stdout.split("\x1e").map((s) => s.trim()).filter(Boolean).map((s) => {
      const [hash, short, subject, author, when, parents] = s.split("\x1f");
      return { hash, short, subject, author, when, merge: (parents ?? "").trim().includes(" "), own: own.has(hash) };
    });
    if (this.selected && !this.commits.some((c) => c.hash === this.selected.hash)) this.selected = null;
    return this.selected ? this.loadRange(git) : [];
  }

  async loadRange(git) {
    const range = this.range();
    if (!range) return [];
    const names = await git([...range, "--name-status", "-z", "--no-renames"]);
    if (names.code !== 0) throw new Error(names.stderr);
    const nums = await git([...range, "--numstat", "-z", "--no-renames"]);
    if (nums.code !== 0) throw new Error(nums.stderr);
    const files = parseRange(names.stdout, nums.stdout);
    this.limited = files.length > 1000;
    return files.slice(0, 1000);
  }

  // What the diff tab compares, as its props; null when nothing is picked.
  diffProps() {
    if (!this.root) return null;
    const where = { folder: this.root, on: this.on };
    if (this.mode === "history") return this.selected ? { ...where, commit: this.selected.hash } : null;
    if (this.mode === "branch") return this.base ? { ...where, base: this.base, compare: this.compare, withWork: this.withWork } : null;
    return { ...where, working: true };
  }

  // A click shows that file's diff in the space's preview tab: opened the first time,
  // reused after (remembered per space, across restarts).
  pick(path, cx) {
    const show = this.diffProps(), space = spaces().find((s) => s.active);
    if (!show || !space) return;
    this.open = path;
    const name = path.split("/").pop(), key = `preview:${space.id}`;
    let saved = null;
    try { saved = JSON.parse(store.get(key)); } catch {}
    if (saved && space.tabs.some((t) => t.id === saved.tab)) {
      setShared("herdr-tsugliani-diff.preview", { ...show, file: path, token: saved.token, n: Date.now() });
      run("tab.rename", { id: saved.tab, name });
      run("tab.select", { id: saved.tab });
    } else {
      const token = Math.random().toString(36).slice(2), before = focused()?.tab;
      run("tab.new", { name, mod: "herdr-tsugliani-diff", props: { ...show, file: path, preview: token } });
      // Only a tab that really opened: if tab.new failed, the focused tab is still the old one.
      const tab = focused()?.tab;
      if (tab && tab !== before) store.set(key, JSON.stringify({ token, tab }));
    }
    cx.notify();
  }

  // Any change to what's compared starts the list and diff over.
  reset(cx) {
    this.files = []; this.open = null; this.limited = false; this.note = null; this.error = null;
    this.refresh(cx, true); cx.notify();
  }

  setMode(mode, cx) {
    if (this.mode === mode) return;
    this.mode = mode; this.picking = null; this.selected = null; store.set("mode", mode);
    this.reset(cx);
  }

  openCommit(commit, cx) { this.selected = commit; this.reset(cx); }

  pickRef(which, cx) {
    if (this.picking === which) { this.picking = null; cx.notify(); return; }
    this.picking = which; this.filter = ""; this.search.set_value("");
    const root = this.root, on = this.on;
    cx.spawn(async (cx) => {
      const r = await exec("git", [...READ, "for-each-ref", "--sort=-committerdate", "--format=%(refname)%09%(refname:short)", "refs/heads", "refs/remotes"], { cwd: root, on }).catch(() => null);
      // origin/HEAD only points at another branch: leave it out.
      if (r?.code === 0 && this.root === root) this.refs = r.stdout.split("\n").map((l) => l.split("\t")).filter(([full, short]) => short && !full.endsWith("/HEAD")).map(([, short]) => short).slice(0, 500);
      cx.notify();
    });
    cx.notify();
  }

  shownRefs() {
    const f = this.filter.trim().toLowerCase();
    const refs = this.picking === "compare" ? ["HEAD", ...this.refs] : this.refs;
    return f ? refs.filter((r) => r.toLowerCase().includes(f)) : refs;
  }

  choose(ref, cx) {
    if (this.picking === "base") { this.base = ref; if (this.root) store.set(`base:${this.root}`, ref); }
    else { this.compare = ref; if (ref !== "HEAD") this.withWork = false; }
    this.picking = null;
    this.reset(cx);
  }

  commit(cx) {
    if (this.mode !== "working" || !this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  chip(id, label, on, t, click) {
    return h_flex().id(id).h(24).px(8).gap(4).min_w(0).flex_shrink_1().items_center().rounded(6).border_1().border_color(on ? t.accent : t.border)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => click(cx))
      .child(div().min_w(0).truncate().child(label)).child(div().text_color(t.dim).text_size(9).child("▾"));
  }

  // The whole diff in a tab of its own (the herdr-tsugliani-diff mod).
  openTab() {
    const props = this.diffProps();
    if (!props) return;
    const name = this.mode === "history" ? this.selected.short : this.mode === "branch" ? `diff ${this.base}` : "uncommitted";
    run("tab.new", { name, mod: "herdr-tsugliani-diff", props });
  }


  tabButton(t) {
    return div().id("open-tab").h(24).px(8).flex().flex_none().items_center().rounded(6).border_1().border_color(t.border).text_size(11).text_color(t.muted)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.openTab()).child("Open in tab ↗");
  }

  modeBar(t) {
    return h_flex().h(34).flex_none().px(8).gap(4).items_center().border_b(1).border_color(t.border).children(MODES.map(([id, label]) =>
      div().id(`mode-${id}`).h(24).px(10).flex().items_center().rounded(6).text_size(12).cursor_pointer()
        .bg(this.mode === id ? t.selected : t.background).text_color(this.mode === id ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.setMode(id, cx)).child(label)))
      .when(this.mode === "working" && this.files.length > 0, (e) => e.child(div().flex_1()).child(this.tabButton(t)));
  }

  branchBar(t) {
    const ahead = this.ahead == null ? "" : `${this.ahead} ahead · ${this.behind} behind`;
    return v_flex().flex_none().px(10).py(8).gap(6).border_b(1).border_color(t.border).text_size(12)
      .child(h_flex().gap(6).items_center().min_w(0)
        .child(this.chip("pick-compare", this.compare === "HEAD" ? `${this.branch ?? "HEAD"}` : this.compare, this.picking === "compare", t, (cx) => this.pickRef("compare", cx)))
        .child(div().flex_none().text_color(t.dim).child("vs"))
        .child(this.chip("pick-base", this.base ?? "pick a base", this.picking === "base", t, (cx) => this.pickRef("base", cx)))
        .child(div().flex_1()).when(Boolean(this.base), (e) => e.child(this.tabButton(t))))
      .child(h_flex().gap(8).items_center().text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(ahead))
        .when(this.compare === "HEAD", (e) => e.child(h_flex().id("with-work").gap(5).items_center().cursor_pointer()
          .on_click((_e, cx) => { this.withWork = !this.withWork; this.reset(cx); })
          .child(div().size(12).rounded(3).border_1().border_color(this.withWork ? t.accent : t.input).bg(this.withWork ? t.accent : t.background))
          .child(div().text_color(t.muted).child("include uncommitted")))));
  }

  commitBar(t) {
    const c = this.selected;
    return h_flex().h(34).flex_none().px(8).gap(8).items_center().border_b(1).border_color(t.border).text_size(12)
      .child(div().id("back").h(24).px(8).flex().flex_none().items_center().rounded(6).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.openCommit(null, cx)).child("← Commits"))
      .child(div().flex_none().text_color(t.accent).font_family(settings().font_family ?? "JetBrains Mono").text_size(11).child(c.short))
      .child(div().flex_1().min_w(0).truncate().child(c.subject))
      .child(this.tabButton(t));
  }

  refList(t) {
    const refs = this.shownRefs();
    return v_flex().flex_1().min_h(0).p(6).gap(4)
      .child(div().id("ref-filter").h(30).px(10).flex().flex_none().items_center().rounded(8).border_1().border_color(t.accent).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.search).h_full().text_size(12).text_color(t.foreground)))
      .child(v_flex().id("refs").flex_1().min_h(0).overflow_y_scrollbar().children(refs.map((ref) => {
        const current = ref === (this.picking === "base" ? this.base : this.compare);
        return div().id(`ref-${ref}`).h(26).flex_none().px(8).flex().items_center().rounded(6).cursor_pointer().truncate()
          .when(current, (e) => e.bg(t.selected)).text_color(ref.includes("/") ? t.muted : t.foreground)
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.choose(ref, cx))
          .child(ref === "HEAD" ? `HEAD (${this.branch ?? "current"})` : ref);
      })).when(!refs.length, (e) => e.child(div().p(8).text_color(t.dim).child("No matching branches"))));
  }

  commitList(t) {
    return v_flex().id("commits").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.commits.map((c) =>
      v_flex().id(`commit-${c.hash}`).flex_none().px(8).py(5).gap(2).rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.openCommit(c, cx))
        .child(h_flex().gap(8).items_center().min_w(0)
          .child(div().size(6).flex_none().rounded(3).bg(c.own ? t.accent : t.background))
          .child(div().flex_1().min_w(0).truncate().child(c.subject)))
        .child(h_flex().gap(8).pl(14).text_size(11).text_color(t.dim)
          .child(div().flex_none().font_family(settings().font_family ?? "JetBrains Mono").child(c.short))
          .child(div().flex_1().min_w(0).truncate().child(`${c.author} · ${c.when}${c.merge ? " · merge" : ""}`)))))
      .when(!this.commits.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading commits…" : "No commits"))));
  }

  fileRow(f, depth, t) {
    const parts = f.path.split("/"), name = parts.pop();
    return h_flex().id(`change-${f.path}`).h(28).flex_none().pl(8 + depth * 14).pr(8).gap(8).items_center().rounded(7).cursor_pointer().when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.path, cx))
      .child(div().w(14).flex_none().text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
      .child(h_flex().flex_1().min_w(0).when(!this.tree, (e) => e.child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : ""))).child(div().max_w(260).min_w(0).truncate().child(name)))
      .when(f.add > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
  }

  dirRow(d, t) {
    const folded = this.folded.has(d.path);
    return h_flex().id(`dir-${d.path}`).h(28).flex_none().pl(8 + d.depth * 14).pr(8).gap(6).items_center().rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { if (folded) this.folded.delete(d.path); else this.folded.add(d.path); cx.notify(); })
      .child(div().w(14).flex_none().text_size(10).text_color(t.dim).child(folded ? "▸" : "▾"))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(`${d.name}/`))
      .when(folded, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(String(d.count))))
      .when(d.add > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi2 + "b0").child(`+${d.add}`))).when(d.del > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi1 + "b0").child(`−${d.del}`)));
  }

  fileList(t) {
    const empty = this.mode === "branch" ? (this.base ? `No differences from ${this.base}` : "Pick a base branch") : this.mode === "history" ? "No file changes in this commit" : "No uncommitted changes";
    const rows = this.tree ? treeRows(this.files, this.folded) : this.files.map((file) => ({ kind: "file", file, depth: 0 }));
    return v_flex().id("changes-list").flex_1().min_h(0).overflow_y_scrollbar().p(6)
      .children(rows.map((row) => row.kind === "dir" ? this.dirRow(row, t) : this.fileRow(row.file, row.depth, t)))
      .when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? empty : "No folder"))));
  }


  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    const commits = this.mode === "history" && !this.selected;
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.picking) { this.picking = null; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
        else if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(commits ? `${this.commits.length} commits` : `${this.files.length} files`))
        .when(!commits && this.files.length > 0, (e) => e.child(div().id("view").px(6).py(1).rounded(4).text_size(10).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.tree = !this.tree; store.set("view", this.tree ? "tree" : "list"); cx.notify(); }).child(this.tree ? "Tree ▾" : "List ▾")))
        .child(div().flex_1()).when(!commits, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`))))
      .child(this.modeBar(t))
      .when(this.mode === "branch" && Boolean(this.root), (e) => e.child(this.branchBar(t)))
      .when(this.mode === "history" && Boolean(this.selected), (e) => e.child(this.commitBar(t)))
      .when(Boolean(this.picking), (e) => e.child(this.refList(t)))
      .when(!this.picking && commits, (e) => e.child(this.commitList(t)))
      .when(!this.picking && !commits, (e) => e.child(this.fileList(t))
        .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files"))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .when(this.mode === "working", (e) => e.child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit"))));
  }
}
