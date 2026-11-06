// Which of a tab's terminals are running a command. Pure, so `node --test` checks it
// (test/tabs.test.mjs).
//
// `terminals()` gives each terminal's own process (`pid`, the shell a tab starts) and
// its `foreground` process. They differ exactly while a command runs. The program name
// isn't enough: `sh ./build.sh` is named after `sh`, so it reads as a shell.
// Agents report their own status and get the shipped spinner, and full-screen tools people
// sit in for hours (editors, pagers, monitors, ssh) would spin forever, so none of those
// count.
export const QUIET = new Set([
  "vi", "vim", "nvim", "neovim", "emacs", "nano", "micro", "hx", "helix", "kak",
  "less", "more", "man", "most",
  "top", "htop", "btop", "btm", "glances", "k9s",
  "lazygit", "gitui", "tig", "lazydocker",
  "yazi", "ranger", "nnn", "lf", "mc",
  "tmux", "zellij", "screen", "ssh", "mosh", "et",
]);

const base = (s) => String(s ?? "").split("/").pop().toLowerCase();

export function isRunning(term) {
  const fg = term?.foreground;
  if (!fg || term.state !== "live" || term.program?.agent || term.status || term.report) return false;
  if (fg.pid == null || fg.pid === term.pid) return false;
  return !QUIET.has(base(fg.argv?.[0])) && !QUIET.has(base(fg.name)) && !QUIET.has(String(term.program?.key ?? "").toLowerCase());
}

// Interpreters a script runs under: the label shows the script, not them.
const RUNNERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "python", "python3", "node", "ruby", "perl", "deno", "bun"]);

// What a busy terminal is doing, for people. The title the shell set when the command
// started (zsh's preexec, as typed), unless it is a prompt-style "user@host:dir" title;
// else the foreground command line, without its interpreter and with paths cut to names.
export function commandLabel(term) {
  const title = String(term?.title ?? "").trim();
  if (title && !/^[^\s@]+@[^\s:]+:/.test(title)) return title;
  const argv = [...(term?.foreground?.argv ?? [])];
  if (argv.length > 1 && RUNNERS.has(base(argv[0])) && !argv[1].startsWith("-")) argv.shift();
  if (argv.length === 0) return term?.foreground?.name ?? "";
  argv[0] = argv[0].includes("/") && !argv[0].startsWith("./") ? base(argv[0]) : argv[0];
  return argv.join(" ");
}

// The commands running in a tab, labelled, in pane order.
export function runningIn(terminals, panes, tab) {
  const inTab = panes.filter((p) => p.tab === tab && p.terminal).map((p) => p.terminal);
  return inTab.map((a) => terminals.find((t) => t.address === a)).filter(isRunning).map(commandLabel);
}

// Tabs Herdr named itself ("2", or an id): those show what runs instead. A name of your own stays.
export const autoNamed = (name) => /^(\d+|tb\d+)$/.test(String(name ?? ""));

// The tab's text while it runs `label`: "2 · make test" for a numbered tab.
export function busyName(name, label) {
  return /^\d+$/.test(String(name)) ? `${name} · ${label}` : label;
}
