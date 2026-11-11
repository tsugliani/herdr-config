import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { spaces, panes, focused, props, exec, theme, settings, nextCommand, shared, setShared, run } from "herdr";
import { MAX_ROWS, parse, pairRows, TABS, CLOSE_AFTER_MS, idleVerdict, registered } from "./diff.js";

// A diff as a tab: `git diff <base>...HEAD` by default, inline or side by side.
// props: { folder?, on?, base?, compare? ("HEAD"), withWork?, commit?, working?, file?, preview? }
// Without a folder it uses the space's first terminal; without a base, main/master.
// file: only that file. preview: a token; the tab then shows what the Changes panel
// last put in shared("herdr-tsugliani-diff.preview") with that token.
// token (or preview): the tab's key in shared(TABS). A tab the Changes panel opened on this
// device closes itself after CLOSE_AFTER_MS unseen (props.closeAfter: other ms, 0 never);
// see diff.js.

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const DIFF = ["--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"];
// What a repo with no commits yet is compared against.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// One height for every row: the list then needs no per-row sizes.
const ROW_H = 22;

function spaceFolder() {
  const space = spaces().find((s) => s.active), tabs = new Set((space?.tabs ?? []).map((t) => t.id));
  const pane = panes().find((p) => tabs.has(p.tab) && p.terminal && p.cwd);
  return { cwd: pane?.cwd ?? focused()?.cwd ?? space?.folder, on: space?.machine ?? null };
}

export default class GitDiff extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.p = p; this.files = []; this.all = []; this.rows = []; this.pairs = []; this.folded = new Set(); this.gen = 0;
    this.withWork = Boolean(p.withWork);
    this.handle = cx.focus_handle(); this.scroll = VirtualListScrollHandle.new();
    this.load(cx);
    cx.timer.every(10000, (cx) => this.poll(cx));
    this.lastSeen = Date.now();
    cx.timer.every(15000, () => this.closeIfIdle());
    // A preview tab follows the Changes panel's picks. Checked here, not in render(): loading
    // notifies, and render() may not ask for a re-render.
    if (p.preview) cx.timer.every(150, (cx) => this.followPreview(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.handle.focus();
        cx.notify();
      }
    });
  }

  // Closes this tab once it has gone unseen long enough, only on the device that opened it.
  closeIfIdle() {
    const token = this.p.token ?? this.p.preview, after = this.p.closeAfter ?? CLOSE_AFTER_MS;
    const tabs = shared(TABS) ?? {}, tab = token ? tabs[token] : null;
    if (!tab || !(after > 0)) return;
    const now = Date.now(), all = spaces();
    const verdict = idleVerdict(all, tab, this.lastSeen, now, after);
    if (verdict === "seen") this.lastSeen = now;
    if (verdict === "gone" || verdict === "close") {
      const { [token]: _mine, ...rest } = tabs;
      setShared(TABS, registered(rest, all));
    }
    if (verdict === "close") run("tab.close", { id: tab });
  }

  git(args) { return exec("git", [...READ, ...args], { cwd: this.root, on: this.on }); }

  // What is compared, as a git command without output options.
  async range() {
    const p = this.p;
    if (p.commit) return ["show", "--format=", "-m", "--first-parent", p.commit];
    if (p.working) return ["diff", this.head()];
    if (this.withWork && this.compare === "HEAD") {
      const mb = await this.git(["merge-base", this.base, "HEAD"]);
      if (mb.code !== 0) throw new Error(`${this.base} and HEAD share no history`);
      return ["diff", mb.stdout.trim()];
    }
    return ["diff", `${this.base}...${this.compare}`];
  }

  async defaultBase() {
    const remote = await this.git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    const named = remote.code === 0 ? remote.stdout.trim() : null;
    for (const ref of [named?.replace(/^origin\//, ""), named, "main", "master", "origin/main", "origin/master", "trunk", "develop"].filter(Boolean)) {
      if ((await this.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).code === 0) return ref;
    }
    return null;
  }

  // What changes when the diff would: the refs, and the working tree when it's included.
  head() { return this.hasHead ? "HEAD" : EMPTY_TREE; }

  async signature() {
    const refs = this.p.commit ? [] : [this.base ?? "HEAD", this.compare ?? "HEAD"];
    const parts = [refs.length ? (await this.git(["rev-parse", ...refs])).stdout : ""];
    if (this.p.working || (this.withWork && this.compare === "HEAD")) parts.push((await this.git(["diff", this.head(), "--numstat"])).stdout);
    if (this.p.working) {
      // Untracked files: their names and checksums, in one command (numstat doesn't see them).
      const sum = `git ${READ.join(" ")} ls-files --others --exclude-standard -z -- "$@" | xargs -0 cksum`;
      parts.push((await exec("sh", ["-c", sum, "sh", ...(this.p.file ? [this.p.file] : [])], { cwd: this.root, on: this.on })).stdout);
    }
    return parts.join("|");
  }

  poll(cx) {
    if (this.loading || !this.root) return;
    cx.spawn(async (cx) => {
      const sig = await this.signature().catch(() => null);
      if (sig !== null && sig !== this.sig) this.load(cx);
    });
  }

  // force: what to show changed; any load still running is dropped.
  load(cx, force) {
    if (this.loading && !force) return;
    const gen = ++this.gen, live = () => this.gen === gen;
    this.loading = true; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (!this.root) {
          const where = this.p.folder ? { cwd: this.p.folder, on: this.p.on ?? null } : spaceFolder();
          if (!where.cwd) throw new Error("No folder for this diff");
          const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: where.cwd, on: where.on });
          if (top.code !== 0) throw new Error(`Not a git repository: ${where.cwd}`);
          this.root = top.stdout.trim(); this.on = where.on;
          setShared("herdr-tsugliani-diff.last", { root: this.root, on: this.on });
          this.hasHead = (await this.git(["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0;
          const branch = await this.git(["branch", "--show-current"]);
          this.branch = branch.stdout.trim() || "HEAD";
          this.compare = this.p.compare ?? "HEAD";
          if (!this.p.commit && !this.p.working) {
            this.base = this.p.base ?? await this.defaultBase();
            if (!this.base) throw new Error("No main or master branch to compare with");
          }
        }
        if (this.base) {
          const counts = await this.git(["rev-list", "--left-right", "--count", `${this.base}...${this.compare}`]);
          [this.behind, this.ahead] = counts.stdout.trim().split(/\s+/).map(Number);
        }
        if (this.p.commit && !this.subject) this.subject = (await this.git(["log", "-1", "--format=%h %s", this.p.commit])).stdout.trim();
        this.sig = await this.signature();
        const only = this.p.file ? ["--", this.p.file] : [];
        const r = await this.git([...await this.range(), ...DIFF, ...only]);
        if (r.code !== 0) throw new Error(r.stderr.trim());
        let text = r.stdout;
        // Uncommitted: new files git doesn't track yet, as added.
        if (this.p.working) {
          const fresh = await this.git(["ls-files", "--others", "--exclude-standard", "-z", ...only]);
          const paths = fresh.stdout.split("\0").filter(Boolean).slice(0, 200);
          if (paths.length) {
            // One command for all of them: on a remote machine each command is a round trip.
            // git diff --no-index exits 1 when the files differ, which they always do here.
            const loop = `for f; do git ${[...READ, "diff", "--no-index", ...DIFF].join(" ")} -- /dev/null "$f"; done`;
            const d = await exec("sh", ["-c", loop, "sh", ...paths], { cwd: this.root, on: this.on });
            text += (text && !text.endsWith("\n") ? "\n" : "") + d.stdout;
          }
        }
        if (!live()) return;
        const { files, rows, cut } = parse(text);
        this.files = files; this.all = rows; this.cut = cut;
        const paths = new Set(files.map((f) => f.path));
        for (const path of this.folded) if (!paths.has(path)) this.folded.delete(path);
        this.layoutRows();
      } catch (e) { if (live()) this.error = String(e.message ?? e).trim(); }
      finally { if (live()) this.loading = false; cx.notify(); }
    });
  }

  // Folded files keep their header row only. Both views are kept, for the toggle.
  layoutRows() {
    this.rows = this.all.filter((row) => row.kind === "file" || !this.folded.has(row.file.path));
    this.rows.forEach((row, i) => { if (row.kind === "file") row.file.at = i; });
    this.pairs = pairRows(this.rows);
    this.pairs.forEach((row, i) => { if (row.kind === "file") row.file.atPair = i; });
  }

  split() { return shared("herdr-tsugliani-diff.split") === true; }
  shown() { return this.split() ? this.pairs : this.rows; }
  at(file) { return this.split() ? file.atPair : file.at; }

  fold(file, cx) {
    if (this.folded.has(file.path)) this.folded.delete(file.path); else this.folded.add(file.path);
    this.layoutRows(); this.scroll.scroll_to_item(this.at(file), "top"); cx.notify();
  }

  jump(file, cx) {
    this.current = file.path;
    if (this.folded.delete(file.path)) this.layoutRows();
    this.scroll.scroll_to_item(this.at(file), "top"); cx.notify();
  }

  step(delta, cx) {
    if (!this.files.length) return;
    const i = this.files.findIndex((f) => f.path === this.current);
    this.jump(this.files[Math.max(0, Math.min(this.files.length - 1, (i < 0 ? -1 : i) + delta))], cx);
  }

  title() {
    if (this.p.file) return this.p.file;
    return this.what();
  }

  // What is compared, in words.
  what() {
    if (this.p.commit) return this.subject || this.p.commit.slice(0, 7);
    if (this.p.working) return `${this.branch ?? ""} · uncommitted`;
    return `${this.compare === "HEAD" ? this.branch ?? "HEAD" : this.compare} vs ${this.base ?? "…"}`;
  }

  row(row, t) {
    if (row.kind === "file") {
      const f = row.file, folded = this.folded.has(f.path);
      // No handlers in here: the list's on_item_click folds the file.
      return h_flex().w_full().h(ROW_H).flex_none().px(12).gap(8).items_center().bg(t.raised).border_t(1).border_color(t.border)
        .cursor_pointer().font_family(settings().ui_font_family ?? "Geist").text_size(12)
        .child(div().w(12).text_color(t.dim).child(folded ? "▸" : "▾"))
        .child(div().w(12).text_color(this.color(f, t)).child(f.status))
        .child(div().font_semibold().min_w(0).truncate().child(f.path))
        .child(div().text_color(t.ansi2).child(`+${f.add}`)).child(div().text_color(t.ansi1).child(`−${f.del}`));
    }
    if (row.kind === "@") return div().w_full().h(ROW_H).flex_none().pl(92).flex().items_center().truncate().text_color(t.dim).bg(t.surface).child(row.text);
    if (row.kind === "pair") return h_flex().w_full().h(ROW_H).flex_none()
      .child(this.side(row.left, "-", t)).child(div().w(1).h_full().flex_none().bg(t.border)).child(this.side(row.right, "+", t));
    if (row.kind === "meta") return div().w_full().h(ROW_H).flex_none().pl(92).flex().items_center().text_color(t.dim).child(row.text);
    return h_flex().w_full().h(ROW_H).flex_none().items_center()
      .when(row.kind === "+", (e) => e.bg(t.ansi2 + "1c")).when(row.kind === "-", (e) => e.bg(t.ansi1 + "1c"))
      .child(div().w(40).flex_none().text_right().text_color(t.dim).child(row.a === undefined ? "" : String(row.a)))
      .child(div().w(40).flex_none().text_right().text_color(t.dim).child(row.b === undefined ? "" : String(row.b)))
      .child(div().w(12).ml(8).flex_none().text_color(row.kind === "+" ? t.ansi2 : row.kind === "-" ? t.ansi1 : t.dim).child(row.kind === " " ? "" : row.kind))
      .child(div().flex_1().min_w(0).truncate().child(row.text));
  }

  side(row, sign, t) {
    const changed = row && row.kind !== " ";
    const tint = sign === "-" ? t.ansi1 : t.ansi2;
    return h_flex().flex_1().min_w(0).h_full().items_center()
      .when(!row, (e) => e.bg(t.surface)).when(Boolean(changed), (e) => e.bg(tint + "1c"))
      .child(div().w(40).flex_none().text_right().text_color(t.dim).child(row ? String(sign === "-" ? row.a : row.b) : ""))
      .child(div().w(12).ml(8).flex_none().text_color(tint).child(changed ? sign : ""))
      .child(div().flex_1().min_w(0).truncate().child(row ? row.text : ""));
  }

  color(f, t) { return f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : t.blocked; }

  button(id, label, on, t, click) {
    return div().id(id).h(26).px(10).flex().flex_none().items_center().rounded(6).text_size(12).cursor_pointer()
      .border_1().border_color(on ? t.accent : t.border).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => click(cx)).child(label);
  }

  // A preview tab shows the file the Changes panel picked last.
  followPreview(cx) {
    if (!this.p.preview) return;
    const msg = shared("herdr-tsugliani-diff.preview");
    if (!msg || msg.token !== this.p.preview || msg.n === this.seen) return;
    this.seen = msg.n;
    const { n: _n, token: _token, ...next } = msg;
    this.p = { ...next, preview: this.p.preview };
    this.root = null; this.base = null; this.subject = null; this.ahead = null; this.withWork = Boolean(next.withWork); this.folded.clear();
    this.load(cx, true);
  }

  render(cx) {
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const stats = this.p.file ? this.what()
      : [this.ahead != null && !this.p.commit && !this.p.working ? `${this.ahead} commits ahead, ${this.behind} behind` : null, `${this.files.length} files`].filter(Boolean).join(" · ");
    const rows = this.shown();
    const canWork = !this.p.commit && !this.p.working && this.compare === "HEAD";
    return v_flex().id("herdr-tsugliani-diff").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "n" || e.key === "j") this.step(1, cx);
        else if (e.key === "p" || e.key === "k") this.step(-1, cx);
        else if (e.key === "r") this.load(cx);
        else return;
        cx.stop_propagation();
      })
      .child(h_flex().h(44).flex_none().px(14).gap(10).items_center().border_b(1).border_color(t.border).bg(t.chrome)
        .child(div().font_semibold().min_w(0).truncate().child(this.title()))
        .child(div().text_size(12).text_color(t.dim).flex_none().child(stats))
        .child(div().text_size(12).text_color(t.ansi2).flex_none().child(`+${add}`)).child(div().text_size(12).text_color(t.ansi1).flex_none().child(`−${del}`))
        .child(div().flex_1())
        .when(canWork, (e) => e.child(this.button("with-work", "Include uncommitted", this.withWork, t, (cx) => { this.withWork = !this.withWork; this.load(cx); })))
        .child(this.button("split", this.split() ? "View: Side by side" : "View: Inline", false, t, () => setShared("herdr-tsugliani-diff.split", !this.split())))
        .when(!this.p.file, (e) => e.child(this.button("fold-all", this.folded.size ? "Expand all" : "Collapse all", false, t, (cx) => {
          if (this.folded.size) this.folded.clear(); else this.files.forEach((f) => this.folded.add(f.path));
          this.layoutRows(); cx.notify();
        })))
        .child(this.button("reload", this.loading ? "Loading…" : "Refresh", false, t, (cx) => this.load(cx))))
      .when(Boolean(this.error), (e) => e.child(div().p(16).text_color(t.ansi1).child(this.error)))
      .when(!this.error, (e) => e.child(h_flex().flex_1().min_h(0)
        .child(div().flex_1().min_w(0).h_full().relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
          .child(v_virtual_list("diff-rows", rows.length, ROW_H, (i) => String(i),
            (range) => rows.slice(range.start, range.end).map((row) => this.row(row, t)))
            .on_item_click((key, cx) => { const row = this.shown()[Number(key)]; if (row?.kind === "file") this.fold(row.file, cx); })
            .track_scroll(this.scroll).size_full())
          .child(Scrollbar.vertical("diff-rows").viewport_from_layout().absolute().inset_0())
          .when(!rows.length, (x) => x.child(div().absolute().top(12).left(16).text_color(t.dim).child(this.loading ? "Loading…" : "No differences")))
          .when(this.cut, (x) => x.child(div().absolute().bottom(8).right(16).px(8).py(4).rounded(6).bg(t.raised).text_size(11).text_color(t.dim).child(`Showing the first ${MAX_ROWS.toLocaleString()} lines`))))));
  }
}
