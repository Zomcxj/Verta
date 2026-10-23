// Count comment lines that still carry Chinese, per top-level directory.
// A throwaway gauge for the "comments in English" pass: comments only, so the
// string tables and theme descriptions do not count against it.
const fs = require("node:fs");
const path = require("node:path");

const CJK = /[\u4e00-\u9fff]/;
const COMMENT = /^\s*(\/\/|\*|\/\*|#|<!--)/;
const roots = process.argv.slice(2);
if (roots.length === 0) roots.push("src", "scripts", "src-tauri/src");

let total = 0;
const byFile = {};
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(p); continue; }
    if (!/\.(tsx?|rs|css|mjs|cjs|ps1|js)$/.test(entry.name) || /\.test\./.test(entry.name)) continue;
    const lines = fs.readFileSync(p, "utf8").split("\n");
    let n = 0;
    for (const line of lines) if (COMMENT.test(line) && CJK.test(line)) n++;
    if (n > 0) { byFile[p] = n; total += n; }
  }
}
for (const r of roots) walk(r);
const sorted = Object.entries(byFile).sort((a, b) => b[1] - a[1]);
console.log(`comment lines with Chinese: ${total} in ${sorted.length} files`);
for (const [f, n] of sorted.slice(0, 15)) console.log(`  ${n}\t${f}`);
