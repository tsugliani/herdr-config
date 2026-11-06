// node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, pairRows } from "../mods/herdr-tsugliani-diff/diff.js";

const DIFF = `diff --git a/src/app.py b/src/app.py
index 1111111..2222222 100644
--- a/src/app.py
+++ b/src/app.py
@@ -1,4 +1,5 @@
 import os
-x = 1
-y = 2
+x = 10
+print(x)
 done = True
+extra = 3
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 4444444..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`;

test("parse finds each file with its status and counts", () => {
  const { files } = parse(DIFF);
  assert.deepEqual(files.map((f) => [f.path, f.status, f.add, f.del]), [
    ["src/app.py", "M", 3, 2],
    ["new.txt", "A", 2, 0],
    ["old.txt", "D", 0, 1],
  ]);
});

test("parse numbers old and new lines", () => {
  const rows = parse(DIFF).rows.filter((r) => r.file.path === "src/app.py" && "text" in r && r.kind !== "@");
  assert.deepEqual(rows.map((r) => [r.kind, r.a, r.b, r.text]), [
    [" ", 1, 1, "import os"],
    ["-", 2, undefined, "x = 1"],
    ["-", 3, undefined, "y = 2"],
    ["+", undefined, 2, "x = 10"],
    ["+", undefined, 3, "print(x)"],
    [" ", 4, 4, "done = True"],
    ["+", undefined, 5, "extra = 3"],
  ]);
});

test("pairRows puts removed lines beside the added lines after them", () => {
  const pairs = pairRows(parse(DIFF).rows).filter((r) => r.kind === "pair" && r.file.path === "src/app.py");
  const side = (r) => (r ? r.text : null);
  assert.deepEqual(pairs.map((p) => [side(p.left), side(p.right)]), [
    ["import os", "import os"],
    ["x = 1", "x = 10"],
    ["y = 2", "print(x)"],
    ["done = True", "done = True"],
    [null, "extra = 3"],
  ]);
});
