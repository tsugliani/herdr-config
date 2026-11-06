// node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { isRunning, runningIn, commandLabel, autoNamed, busyName } from "../mods/herdr-tsugliani-tabs/running.js";

// A terminal as terminals() describes it: its shell is pid 100.
const term = (address, fg, extra = {}) => ({
  address, pid: 100, state: "live", status: null, report: null, title: "",
  program: { key: "shell", name: "zsh", shell: true, agent: false },
  foreground: fg, ...extra,
});
const ZSH = { pid: 100, name: "zsh", argv: ["/bin/zsh", "-l"] };

test("a shell at its prompt is not running anything; a command in it is", () => {
  assert.equal(isRunning(term("t1", ZSH)), false);
  assert.equal(isRunning(term("t1", { pid: 200, name: "sleep", argv: ["sleep", "20"] })), true);
});

test("a script run by sh counts, though Herdr names it after the shell", () => {
  const t = term("t1", { pid: 200, name: "build-zboxdeskt", argv: ["/bin/sh", "./build-zboxdesktop.sh"] },
    { program: { key: "shell", name: "sh", shell: true, agent: false } });
  assert.equal(isRunning(t), true);
});

test("agents, finished terminals and full-screen tools never count", () => {
  const cmd = { pid: 200, name: "node", argv: ["node", "x.js"] };
  assert.equal(isRunning(term("t1", cmd, { program: { key: "claude", agent: true } })), false);
  assert.equal(isRunning(term("t1", cmd, { status: "working" })), false);
  assert.equal(isRunning(term("t1", cmd, { state: "finished" })), false);
  assert.equal(isRunning(term("t1", { pid: 200, name: "nvim", argv: ["nvim", "a"] })), false);
  assert.equal(isRunning(term("t1", { pid: 200, name: "htop", argv: ["/usr/bin/htop"] })), false);
  assert.equal(isRunning(term("t1", { pid: 200, name: "ssh", argv: ["ssh", "box"] })), false);
  assert.equal(isRunning(term("t1", null)), false);
  assert.equal(isRunning(null), false);
});

test("runningIn lists the commands of one tab only, by title", () => {
  const terms = [
    term("t1", { pid: 200, name: "make", argv: ["make"] }, { title: "make test" }),
    term("t2", ZSH),
    term("zboxdev/t3", { pid: 300, name: "sleep", argv: ["sleep", "9"] }),
  ];
  const panes = [{ tab: "a", terminal: "t1" }, { tab: "a", terminal: "t2" }, { tab: "a", terminal: null }, { tab: "b", terminal: "zboxdev/t3" }];
  assert.deepEqual(runningIn(terms, panes, "a"), ["make test"]);
  assert.deepEqual(runningIn(terms, panes, "b"), ["sleep 9"]);
  assert.deepEqual(runningIn(terms, panes, "c"), []);
});

test("the label is what the shell titled the command, else its command line", () => {
  const fg = (argv) => ({ pid: 200, name: argv[0], argv });
  assert.equal(commandLabel({ title: "./build-zboxdesktop.sh", foreground: fg(["/bin/sh", "./build-zboxdesktop.sh"]) }), "./build-zboxdesktop.sh");
  // A prompt-style title is the shell's, not the command's.
  assert.equal(commandLabel({ title: "me@box:~/git", foreground: fg(["/bin/sh", "./build.sh", "-v"]) }), "./build.sh -v");
  assert.equal(commandLabel({ title: "", foreground: fg(["/usr/bin/python3", "/home/x/run.py", "a"]) }), "run.py a");
  assert.equal(commandLabel({ title: "", foreground: fg(["/usr/local/bin/make", "test"]) }), "make test");
  assert.equal(commandLabel({ title: "", foreground: fg(["bash", "-c", "x"]) }), "bash -c x");
});

test("only tabs Herdr named show the command, numbered ones keep their number", () => {
  assert.equal(autoNamed("2"), true);
  assert.equal(autoNamed("tb12"), true);
  assert.equal(autoNamed("HTOP"), false);
  assert.equal(busyName("2", "make test"), "2 · make test");
  assert.equal(busyName("tb12", "make test"), "make test");
});
