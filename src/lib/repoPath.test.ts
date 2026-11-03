import { describe, expect, it } from "vitest";
import { changeTouchesRepo } from "./repoPath";

describe("changeTouchesRepo", () => {
  it("accepts a change inside the repository", () => {
    expect(changeTouchesRepo(["D:/VsPro/Verta/src/main.tsx"], "D:/VsPro/Verta")).toBe(
      true,
    );
  });

  it("accepts the root itself", () => {
    // A commit rewrites `.git` and a checkout rewrites the root; both are reported at the root.
    expect(changeTouchesRepo(["D:/VsPro/Verta"], "D:/VsPro/Verta")).toBe(true);
  });

  it("refuses a sibling whose name starts with the same letters", () => {
    // `Verta-old` is not inside `Verta`, and a plain `startsWith` would say it is.
    expect(changeTouchesRepo(["D:/VsPro/Verta-old/src"], "D:/VsPro/Verta")).toBe(false);
  });

  it("refuses everything when there is no repository", () => {
    expect(changeTouchesRepo(["D:/VsPro/Verta"], null)).toBe(false);
    expect(changeTouchesRepo(["D:/VsPro/Verta"], "")).toBe(false);
  });

  it("reads a Windows path with either separator and a trailing one", () => {
    expect(
      changeTouchesRepo(["D:\\VsPro\\Verta\\src\\main.tsx"], "D:/VsPro/Verta/"),
    ).toBe(true);
    expect(changeTouchesRepo(["D:/VsPro/Verta/"], "D:\\VsPro\\Verta")).toBe(true);
  });

  it("answers for the whole list, not only its first entry", () => {
    // `fs:changed` carries every directory a single native event covered.
    expect(
      changeTouchesRepo(["C:/Users/x", "D:/VsPro/Verta/.git"], "D:/VsPro/Verta"),
    ).toBe(true);
    expect(changeTouchesRepo(["C:/Users/x", "E:/other"], "D:/VsPro/Verta")).toBe(
      false,
    );
  });
});
