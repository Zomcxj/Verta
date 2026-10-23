import { describe, expect, it } from "vitest";

import { relativeToRoot } from "./sessionPaths";

// The separator is built from String.fromCharCode(92), so the escaping rules of templates
// and regexes cannot mangle it.
const B = String.fromCharCode(92);
const abs = (...parts: string[]) => parts.join(B);
const ROOT = abs("F:", "VibeCoding_workspace");

describe("relativeToRoot", () => {
  it("strips the workspace root, whichever slash style came in", () => {
    expect(relativeToRoot(ROOT, abs("F:", "VibeCoding_workspace", "ModelHarbor"))).toBe("ModelHarbor");
    expect(relativeToRoot("F:/work", abs("F:", "work", "a", "b"))).toBe("a/b");
  });

  it("the root itself is a dot", () => {
    expect(relativeToRoot(abs("F:", "work") + B, abs("F:", "work"))).toBe(".");
  });

  it("a path outside the root has no relative form", () => {
    expect(relativeToRoot(abs("F:", "work"), abs("D:", "other", "x"))).toBeNull();
    expect(relativeToRoot(abs("F:", "work"), abs("F:", "workshop", "x"))).toBeNull();
  });

  it("nothing to compare is null, not an empty string", () => {
    expect(relativeToRoot(null, abs("F:", "x"))).toBeNull();
    expect(relativeToRoot("", abs("F:", "x"))).toBeNull();
    expect(relativeToRoot(abs("F:", "work"), null)).toBeNull();
  });
});
