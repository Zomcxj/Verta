// Reassemble CHANGES.md from the rewritten date blocks, and check that nothing was lost.
//
// The rewrite was done block by block (one file per date). This puts them back in the original order,
// adds the `<details>` markup that the blocks do not carry, makes only the newest day `open`, and then
// compares the result with the original: every backticked file path the original named has to still be
// named, and no Chinese may remain.
//
// Usage: node scripts/dev/assemble-changes.mjs <orig.md> <parts-dir> <out.md>
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [origPath, partsDir, outPath] = process.argv.slice(2);
if (!origPath || !partsDir || !outPath) {
  console.error("usage: assemble-changes.mjs <orig.md> <parts-dir> <out.md>");
  process.exit(2);
}

const orig = readFileSync(origPath, "utf8");
const header = readFileSync(join(partsDir, "_header.md"), "utf8");

// Dates newest first, exactly as the original listed them.
const dates = [...orig.matchAll(/<summary><strong>(\d{4}-\d{2}-\d{2})<\/strong><\/summary>/g)].map(
  (m) => m[1],
);

const blocks = dates.map((date, index) => {
  const body = readFileSync(join(partsDir, `${date}.md`), "utf8").trimEnd();
  const open = index === 0 ? " open" : "";
  // The blocks carry their own `<summary>` line; the wrapper is added here and nowhere else.
  return `<details${open}>\n${body}\n</details>`;
});

const out = `${header}${blocks.join("\n\n")}\n`;
writeFileSync(outPath, out, "utf8");

// --- checks -------------------------------------------------------------------------------------

const paths = (text) =>
  new Set(
    [...text.matchAll(/`([^`\n]{2,120})`/g)]
      .map((m) => m[1])
      .filter((token) => /(src\/|src-tauri\/|scripts\/)/.test(token) || /\.(rs|ts|tsx|mjs)$/.test(token)),
  );

const before = paths(orig);
const after = paths(out);
const missing = [...before].filter((path) => !after.has(path));
const added = [...after].filter((path) => !before.has(path));

const cjk = [...out.matchAll(/[\u4e00-\u9fff]/g)].length;
const openCount = (out.match(/^<details open>$/gm) ?? []).length;
// Line-anchored: the file's own preamble mentions the tag inside backticks.
const detailsOpen = (out.match(/^<details/gm) ?? []).length;
const detailsClose = (out.match(/<\/details>/g) ?? []).length;

console.log(`blocks: ${dates.length}`);
console.log(`details: ${detailsOpen} open tags, ${detailsClose} closing tags, ${openCount} of them open`);
console.log(`paths: ${before.size} in the original, ${after.size} now`);
console.log(`missing paths (${missing.length}):`);
for (const path of missing) console.log(`  - ${path}`);
console.log(`added paths (${added.length}):`);
for (const path of added) console.log(`  + ${path}`);
console.log(`Chinese characters left: ${cjk}`);

const ok =
  missing.length === 0 &&
  detailsOpen === detailsClose &&
  openCount === 1 &&
  cjk === 0;
console.log(
  ok
    ? "\nPASS: every named path survived, the markup closes, one day is open, no Chinese remains."
    : "\nFAIL: see the counts above.",
);
process.exit(ok ? 0 : 1);
