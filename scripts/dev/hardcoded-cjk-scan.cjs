// Find Chinese text hard-coded in TSX/TS that bypasses t()/tr() (comments excluded).
const fs = require("node:fs");
const path = require("node:path");

const CJK = /[\u4e00-\u9fff]/;
const roots = ["src/modules/launcher", "src/modules/tabs", "src/modules/terminal", "src/app"];
const out = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(p); continue; }
    if (!/\.(tsx?|rs)$/.test(entry.name) || /\.test\./.test(entry.name)) continue;
    const text = fs.readFileSync(p, "utf8");
    text.split("\n").forEach((line, i) => {
      if (!CJK.test(line)) return;
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
      if (trimmed.startsWith("{/*") || trimmed.startsWith("*/")) return;
      // Chinese in key names / inside the files themselves is not user-facing copy
      if (/messages\.ts|themeNames\.ts/.test(p)) return;
      out.push(`${p}:${i + 1}: ${trimmed.slice(0, 100)}`);
    });
  }
}
walk("src");
fs.writeFileSync("hardcoded.txt", out.join("\n"));
const byFile = {};
for (const line of out) { const f = line.split(":")[0]; byFile[f] = (byFile[f] || 0) + 1; }
console.log("total:", out.length, "files:", Object.keys(byFile).length);
for (const [f, n] of Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(n, f);
