import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The documentation set, checked for the ways documentation rots.
 *
 * This repository's docs are the only record of why several rules exist, so a link to a file that
 * moved and a claim about a probe that was renamed are worse than no link at all: the reader trusts
 * it, follows it, and concludes the rule no longer applies.
 *
 * Read as text: this file asserts structure, not prose.
 */
const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

const entry = read("VERTA.md");
const readme = read("README.md");
const contributing = read("CONTRIBUTING.md");
const security = read("SECURITY.md");
const docs = readdirSync(new URL("docs", root))
  .filter((name) => name.endsWith(".md"))
  .map((name) => ({ name, text: read(`docs/${name}`) }));

/** Every `something.md` a document points at. */
function linksIn(text: string): string[] {
  return [...text.matchAll(/\]\(([^)]+\.md)\)/g)].map((match) => match[1]);
}

describe("the documentation set", () => {
  it("links only to files that exist", () => {
    const broken: string[] = [];
    for (const { name, text } of docs) {
      for (const link of linksIn(text)) {
        if (!existsSync(new URL(link, new URL(`docs/${name}`, root)))) {
          broken.push(`docs/${name} -> ${link}`);
        }
      }
    }
    for (const [name, text] of [
      ["VERTA.md", entry],
      ["README.md", readme],
      ["CONTRIBUTING.md", contributing],
      ["SECURITY.md", security],
    ] as const) {
      for (const link of linksIn(text)) {
        if (!existsSync(new URL(link, root))) broken.push(`${name} -> ${link}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("reaches every doc from the two entry points, and from the index", () => {
    // A doc nobody links is a doc nobody reads: `VERTA.md` is what an agent loads, `README.md` is what
    // a person opens first, `docs/README.md` is the map, and between them they have to cover the set.
    const index = read("docs/README.md");
    const reached = new Set([
      ...linksIn(entry),
      ...linksIn(readme),
      ...linksIn(index),
    ]);
    const unreached = docs
      .map(({ name }) => `docs/${name}`)
      .filter((path) => !reached.has(path));
    expect(unreached).toEqual([]);
    // Both entry points have to point at the index itself, not only at individual pages.
    expect(linksIn(entry)).toContain("docs/README.md");
    expect(linksIn(readme)).toContain("docs/README.md");
  });

  it("names only probes that exist", () => {
    // A verification step that points at a renamed probe is a step that silently stops being taken.
    const mentioned = new Set<string>();
    for (const text of [entry, contributing, ...docs.map((doc) => doc.text)]) {
      for (const match of text.matchAll(/scripts\/dev\/probes\/([\w.-]+)/g)) {
        mentioned.add(match[1]);
      }
    }
    expect(mentioned.size).toBeGreaterThan(0);
    const missing = [...mentioned].filter(
      (name) => !existsSync(new URL(`scripts/dev/probes/${name}`, root)),
    );
    expect(missing).toEqual([]);
  });

  it("keeps the docs in English and the rules out of the prose", () => {
    for (const { name, text } of docs) {
      // The docs are read by outside readers and by the upstream; only interface text is Chinese.
      // Quoted data is the exception: a model id really is spelled `[次]deepseek-v4-flash` by the tool
      // that reports it, and translating it would be a lie about what the file contains.
      const prose = text.replace(/`[^`]*`/g, "");
      const lines = prose
        .split("\n")
        .filter((line) => /[\u4e00-\u9fa5]/.test(line));
      expect(lines, `docs/${name} has Chinese outside quoted data`).toEqual([]);
      // No em-dash anywhere: it is the one typographic habit the project bans outright.
      expect(text).not.toContain("\u2014");
      expect(text).not.toContain("\u2013");
    }
  });

  it("keeps VERTA.md an entry point rather than a second copy of the docs", () => {
    // It is loaded as agent memory on every task, so its length is a cost paid on every task. The
    // terminal section alone used to be 285 of its 466 lines.
    const lines = entry.split("\n").length;
    expect(lines).toBeLessThan(200);
    // The map is links, not content: the detail lives in `docs/`.
    expect(linksIn(entry).length).toBeGreaterThanOrEqual(6);
  });

  it("says where each kind of change is recorded", () => {
    // `CHANGES.md` is the one obligation a contributor cannot discover from the code.
    expect(entry).toContain("CHANGES.md");
    expect(contributing).toContain("CHANGES.md");
    expect(readme).toContain("CHANGES.md");
  });
});
