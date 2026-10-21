import { describe, expect, it } from "vitest";

import type { WireRepoPermissionPayload } from "@/lib/native";
import { canWrite, readOnlyHintKey } from "./permission";

const payload = (
  over: Partial<WireRepoPermissionPayload>,
): WireRepoPermissionPayload => ({
  kind: "ready",
  repo: "me/app",
  permission: "ADMIN",
  canWrite: true,
  error: null,
  ...over,
});

describe("canWrite", () => {
  it("还没查出来时按「能写」算，别先藏了再放回来", () => {
    expect(canWrite(null)).toBe(true);
  });

  it("读得动就听后端", () => {
    expect(canWrite(payload({ permission: "ADMIN", canWrite: true }))).toBe(true);
    expect(canWrite(payload({ permission: "READ", canWrite: false }))).toBe(false);
  });

  it("查不动也按「能写」算：点了让 GitHub 去拒绝，总好过没入口", () => {
    for (const kind of ["notInstalled", "notLoggedIn", "error"] as const) {
      expect(canWrite(payload({ kind, permission: null, canWrite: true }))).toBe(
        true,
      );
    }
  });
});

describe("readOnlyHintKey", () => {
  it("确认只读时给一句提示", () => {
    expect(
      readOnlyHintKey(payload({ permission: "READ", canWrite: false })),
    ).toBe("remotes.permission.readOnly");
  });

  it("能写、还没查出来、查不动都不提示", () => {
    expect(readOnlyHintKey(null)).toBeNull();
    expect(readOnlyHintKey(payload({}))).toBeNull();
    expect(
      readOnlyHintKey(
        payload({ kind: "error", permission: null, canWrite: true }),
      ),
    ).toBeNull();
  });
});
