// Pure diff parsing, kept apart from the view so test/diff.test.mjs can run it under node.

export const MAX_ROWS = 60000;

// The whole unified diff, as files and the rows to draw.
export function parse(text) {
  const files = [], rows = [];
  let file = null, old = 0, next = 0, header = false;
  for (const line of text.split("\n")) {
    if (rows.length >= MAX_ROWS) break;
    if (line.startsWith("diff --git ") || line.startsWith("diff --cc ")) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      file = { path: m ? m[2] : line.slice(11), status: "M", add: 0, del: 0, row: rows.length, binary: false };
      files.push(file); rows.push({ kind: "file", file }); header = true; continue;
    }
    if (!file) continue;
    if (header) {
      if (line.startsWith("new file mode")) file.status = "A";
      else if (line.startsWith("deleted file mode")) file.status = "D";
      else if (line.startsWith("+++ b/")) file.path = line.slice(6);
      else if (line.startsWith("Binary files")) { file.binary = true; rows.push({ kind: "meta", file, text: "Binary file changed" }); }
      if (!line.startsWith("@@")) continue;
      header = false;
    }
    const match = /^@@+ -(\d+)(?:,\d+)? .*?\+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; rows.push({ kind: "@", file, text: line }); continue; }
    const kind = line[0], body = (line.slice(1) || " ").slice(0, 600);
    if (kind === "+") { file.add++; rows.push({ kind, file, b: next++, text: body }); }
    else if (kind === "-") { file.del++; rows.push({ kind, file, a: old++, text: body }); }
    else if (kind === " ") rows.push({ kind, file, a: old++, b: next++, text: body });
    else if (kind === "\\") rows.push({ kind: "meta", file, text: line });
  }
  return { files, rows, cut: rows.length >= MAX_ROWS };
}

// Side by side: removed lines on the left, added on the right, paired in order;
// unchanged lines on both sides.
export function pairRows(rows) {
  const out = [];
  let dels = [], adds = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) out.push({ kind: "pair", file: (dels[i] ?? adds[i]).file, left: dels[i], right: adds[i] });
    dels = []; adds = [];
  };
  for (const row of rows) {
    if (row.kind === "-") { if (adds.length) flush(); dels.push(row); }
    else if (row.kind === "+") adds.push(row);
    else { flush(); out.push(row.kind === " " ? { kind: "pair", file: row.file, left: row, right: row } : row); }
  }
  flush();
  return out;
}
