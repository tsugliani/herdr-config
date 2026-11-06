// node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { newFolder, place, rename, remove, inSection, tag } from "../mods/herdr-tsugliani-spaces/folders.js";

test("a new folder is empty, on its machine, and named", () => {
  const { list, id } = newFolder([], "zboxdev", "f1");
  assert.equal(id, "f1");
  assert.deepEqual(list, [{ id: "f1", name: "New folder", machine: "zboxdev", spaces: [] }]);
  assert.equal(newFolder([], undefined, "f2").list[0].machine, null);
});

test("a space is in one folder at most; null takes it out", () => {
  let list = [{ id: "a", name: "A", machine: null, spaces: [] }, { id: "b", name: "B", machine: null, spaces: [] }];
  list = place(list, "s1", "a");
  list = place(list, "s2", "a");
  assert.deepEqual(list.map((f) => f.spaces), [["s1", "s2"], []]);
  list = place(list, "s1", "b");
  assert.deepEqual(list.map((f) => f.spaces), [["s2"], ["s1"]]);
  list = place(list, "s2", null);
  assert.deepEqual(list.map((f) => f.spaces), [[], ["s1"]]);
});

test("rename trims and ignores blank names; delete only lets spaces out", () => {
  const list = [{ id: "a", name: "A", machine: null, spaces: ["s1"] }];
  assert.equal(rename(list, "a", "  Packer ")[0].name, "Packer");
  assert.equal(rename(list, "a", "   ")[0].name, "A");
  assert.deepEqual(remove(list, "a"), []);
});

test("folders belong to their machine's section", () => {
  const list = [{ id: "a", machine: null, spaces: [] }, { id: "b", machine: "zboxdev", spaces: [] }];
  assert.deepEqual(inSection(list, null).map((f) => f.id), ["a"]);
  assert.deepEqual(inSection(list, undefined).map((f) => f.id), ["a"]);
  assert.deepEqual(inSection(list, "zboxdev").map((f) => f.id), ["b"]);
});

test("rows are tagged with their folder, worktrees going with their checkout", () => {
  const rows = [{ w: { id: "s1" }, tree: null }, { w: { id: "wt" }, tree: "└─" }, { w: { id: "s2" }, tree: null }, { w: { id: "s3" }, tree: null }];
  const list = [{ id: "packer", spaces: ["s1", "s3"] }];
  assert.deepEqual(tag(rows, list).map((r) => r.folder), ["packer", "packer", null, "packer"]);
});

import { DOC, qualify, bare, fromDoc, toDoc, docParams, rpcInput, parseReplies, isConflict } from "../mods/herdr-tsugliani-spaces/folders.js";

test("a remote machine's ids are bare in its document and qualified here", () => {
  assert.equal(qualify("sp1", "zboxdev"), "zboxdev/sp1");
  assert.equal(qualify("sp1", null), "sp1");
  assert.equal(bare("zboxdev/sp1", "zboxdev"), "sp1");
  assert.equal(bare("sp1", null), "sp1");
  const list = [{ id: "packer", name: "Packer", machine: "zboxdev", spaces: ["zboxdev/sp1", "zboxdev/sp2"] },
                { id: "mine", name: "Mine", machine: null, spaces: ["sp9"] }];
  const doc = toDoc(list, "zboxdev");
  assert.deepEqual(doc, { folders: [{ id: "packer", name: "Packer", spaces: ["sp1", "sp2"] }] });
  // Another device that named the machine "zbox" reads the same document as its own.
  assert.deepEqual(fromDoc(doc, "zbox")[0].spaces, ["zbox/sp1", "zbox/sp2"]);
  assert.deepEqual(fromDoc(doc, "zboxdev"), [list[0]]);
  assert.deepEqual(toDoc(list, null), { folders: [{ id: "mine", name: "Mine", spaces: ["sp9"] }] });
});

test("an empty, missing or odd document reads as no folders", () => {
  assert.deepEqual(fromDoc(null, "zboxdev"), []);
  assert.deepEqual(fromDoc({}, null), []);
  assert.deepEqual(fromDoc({ folders: [null, { name: "no id" }] }, null), []);
});

test("requests and replies for hc connect", () => {
  assert.deepEqual(docParams("zboxdev"), { name: DOC, on: "zboxdev" });
  assert.deepEqual(docParams(null, { version: 3 }), { name: DOC, version: 3 });
  const input = rpcInput([{ id: 1, method: "doc.get", params: docParams(null) }]);
  assert.equal(input.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(input), { jsonrpc: "2.0", id: 1, method: "doc.get", params: { name: DOC } });
  const replies = parseReplies('{"id":1,"jsonrpc":"2.0","result":{"value":null,"version":0}}\nnoise\n{"id":2,"jsonrpc":"2.0","error":{"code":-32000,"data":{"kind":"conflict"},"message":"x"}}\n');
  assert.deepEqual(replies.get(1).result, { value: null, version: 0 });
  assert.equal(isConflict(replies.get(2)), true);
  assert.equal(isConflict(replies.get(1)), false);
});
