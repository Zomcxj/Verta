import { describe, expect, it } from "vitest";
import { changeTouchesRepo } from "./statusStore";

describe("changeTouchesRepo", () => {
  it("accepts a change inside the project", () => {
    expect(changeTouchesRepo(["D:/VsPro/Verta/src/main.tsx"], "D:/VsPro/Verta")).toBe(
      true,
    );
  });

  it("accepts the root itself", () => {
    // A commit rewrites `.git` and a checkout rewrites the root; both are reported at the root.
    expect(changeTouchesRepo(["D:/VsPro/Verta"], "D:/VsPro/Verta")).toBe(true);
  });

  it("ignores a directory outside it", () => {
    // The watcher also covers the home directory and every expanded folder of the explorer.
    expect(changeTouchesRepo(["C:/Users/cxj/AppData"], "D:/VsPro/Verta")).toBe(false);
  });

  it("is not fooled by a sibling whose name starts the same", () => {
    expect(changeTouchesRepo(["D:/VsPro/Verta-wip/src"], "D:/VsPro/Verta")).toBe(false);
  });

  it("matches whichever separator the change was reported with", () => {
    expect(changeTouchesRepo(["D:\\VsPro\\Verta\\src"], "D:/VsPro/Verta")).toBe(true);
  });

  it("tolerates a trailing separator on either side", () => {
    expect(changeTouchesRepo(["D:/VsPro/Verta/"], "D:/VsPro/Verta/")).toBe(true);
  });

  it("says no when there is no project to compare with", () => {
    expect(changeTouchesRepo(["D:/VsPro/Verta"], null)).toBe(false);
    expect(changeTouchesRepo(["D:/VsPro/Verta"], "")).toBe(false);
  });

  it("accepts one match among unrelated directories", () => {
    expect(
      changeTouchesRepo(
        ["C:/Users/cxj", "D:/VsPro/Verta/lib", "E:/GitPro/Orca"],
        "D:/VsPro/Verta",
      ),
    ).toBe(true);
  });
});