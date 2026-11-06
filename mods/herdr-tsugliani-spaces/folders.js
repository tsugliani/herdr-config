// Folders in the Spaces list, as plain functions over the stored list, so `node --test`
// checks them (test/spaces.test.mjs). The list lives in shared state under KEY:
//   [{ id, name, machine: null | "<machine>", spaces: [spaceId, ...] }, ...]
// A folder belongs to one machine's section (spaces can't move between machines). A space
// is in at most one folder. Members show in the list's own order; a worktree row (tree)
// goes with the checkout above it.
export const KEY = "herdr-tsugliani-spaces.folders";

export function newFolder(list, machine, id, name = "New folder") {
  return { list: [...list, { id, name, machine: machine ?? null, spaces: [] }], id };
}

// Puts a space in a folder (null: out of every folder).
export function place(list, spaceId, folderId) {
  return list.map((f) => {
    const spaces = f.spaces.filter((s) => s !== spaceId);
    if (f.id === folderId) spaces.push(spaceId);
    return { ...f, spaces };
  });
}

export function rename(list, id, name) {
  const clean = String(name ?? "").trim();
  return clean ? list.map((f) => (f.id === id ? { ...f, name: clean } : f)) : list;
}

// Deleting a folder only lets its spaces out.
export const remove = (list, id) => list.filter((f) => f.id !== id);

export const inSection = (list, machine) => list.filter((f) => (f.machine ?? null) === (machine ?? null));

// Each row with the folder it shows under (null: loose).
export function tag(rows, list) {
  const of = {};
  for (const f of list) for (const s of f.spaces) of[s] = f.id;
  let last = null;
  return rows.map((r) => {
    const folder = r.tree ? last : of[r.w.id] ?? null;
    if (!r.tree) last = folder;
    return { ...r, folder };
  });
}

// ── Stored on each machine's core ──────────────────────────────────────────────────────
// Each machine keeps its own folders in a document of its Herdr core (doc.get / doc.set,
// over `hc connect`): DOC on zboxdev's core for zboxdev's spaces, DOC on this computer's
// core for its own. In the document, space ids are bare ("sp8d…"), as that core knows them;
// here a remote machine's are qualified with the name this device gave it ("zboxdev/sp8d…"),
// as spaces() reports them. Another device may name the machine differently.
export const DOC = "herdr-tsugliani-folders";

export const qualify = (id, machine) => (machine ? `${machine}/${id}` : id);
export const bare = (id, machine) => (machine && id.startsWith(`${machine}/`) ? id.slice(machine.length + 1) : id);

// A document's value as this list's folders on `machine`.
export function fromDoc(value, machine) {
  const m = machine ?? null;
  return (Array.isArray(value?.folders) ? value.folders : [])
    .filter((f) => f && typeof f.id === "string")
    .map((f) => ({ id: f.id, name: String(f.name ?? "Folder"), machine: m, spaces: (f.spaces ?? []).map((s) => qualify(String(s), m)) }));
}

// `machine`'s folders as the value to store in its document.
export function toDoc(list, machine) {
  const m = machine ?? null;
  return { folders: inSection(list, m).map((f) => ({ id: f.id, name: f.name, spaces: f.spaces.map((s) => bare(s, m)) })) };
}

// doc.get / doc.set requests, one JSON-RPC line each, for `hc connect`.
export const docParams = (machine, extra = {}) => ({ name: DOC, ...(machine ? { on: machine } : {}), ...extra });
export const rpcInput = (requests) => requests.map((r) => JSON.stringify({ jsonrpc: "2.0", ...r })).join("\n") + "\n";

// `hc connect`'s replies by request id; lines that aren't replies are skipped.
export function parseReplies(stdout) {
  const out = new Map();
  for (const line of String(stdout ?? "").split("\n")) {
    try { const r = JSON.parse(line); if (r && r.id != null) out.set(r.id, r); } catch {}
  }
  return out;
}

export const isConflict = (reply) => reply?.error?.data?.kind === "conflict";
