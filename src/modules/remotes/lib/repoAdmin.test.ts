import { describe, expect, it } from "vitest";

import type { WireRepoSettingsPayload } from "@/lib/native";
import {
  adminHintKey,
  canAdmin,
  cloneDestBeside,
  cloneDestFromProjects,
  deleteConfirmMatches,
  descriptionProblem,
  isPrivateVisibility,
  repoNameProblem,
} from "./repoAdmin";

const payload = (
  over: Partial<WireRepoSettingsPayload>,
): WireRepoSettingsPayload => ({
  kind: "ready",
  repo: "Zomcxj/ModelHarbor",
  description: "a desktop tool",
  visibility: "PUBLIC",
  canAdmin: true,
  error: null,
  ...over,
});

describe("canAdmin", () => {
  it("还没查出来时按「能改」算", () => {
    expect(canAdmin(null)).toBe(true);
  });

  it("读得动就听后端", () => {
    expect(canAdmin(payload({ canAdmin: true }))).toBe(true);
    expect(canAdmin(payload({ canAdmin: false }))).toBe(false);
  });

  it("查不动也按「能改」算：点了让 GitHub 去拒绝", () => {
    for (const kind of ["notInstalled", "notLoggedIn", "error"] as const) {
      expect(canAdmin(payload({ kind, canAdmin: true }))).toBe(true);
    }
  });
});

describe("adminHintKey", () => {
  it("确认非管理员时给一句提示", () => {
    expect(adminHintKey(payload({ canAdmin: false }))).toBe(
      "remotes.admin.readOnly",
    );
  });

  it("能改、还没查出来、查不动都不提示", () => {
    expect(adminHintKey(null)).toBeNull();
    expect(adminHintKey(payload({}))).toBeNull();
    expect(adminHintKey(payload({ kind: "error", canAdmin: true }))).toBeNull();
  });
});

describe("isPrivateVisibility", () => {
  it("认 PUBLIC / PRIVATE，大小写不敏感", () => {
    expect(isPrivateVisibility("PRIVATE")).toBe(true);
    expect(isPrivateVisibility("private")).toBe(true);
    expect(isPrivateVisibility("PUBLIC")).toBe(false);
  });

  it("组织内可见与拿不到值时都说不出「私有/公开」", () => {
    // INTERNAL fits neither label, so the UI does not decide for it.
    expect(isPrivateVisibility("INTERNAL")).toBeNull();
    expect(isPrivateVisibility(null)).toBeNull();
    expect(isPrivateVisibility("")).toBeNull();
  });
});

describe("deleteConfirmMatches", () => {
  it("只有手输的仓库全名一字不差才算数", () => {
    expect(deleteConfirmMatches("Zomcxj/ModelHarbor", "Zomcxj/ModelHarbor")).toBe(
      true,
    );
    expect(deleteConfirmMatches("  Zomcxj/ModelHarbor  ", "Zomcxj/ModelHarbor")).toBe(
      true,
    );
    // GitHub repository names are not case-sensitive, so this check follows suit.
    expect(deleteConfirmMatches("zomcxj/modelharbor", "Zomcxj/ModelHarbor")).toBe(
      true,
    );
  });

  it("少一段、多一段、别的仓库都不算", () => {
    expect(deleteConfirmMatches("ModelHarbor", "Zomcxj/ModelHarbor")).toBe(false);
    expect(deleteConfirmMatches("Zomcxj/ModelHarbor/x", "Zomcxj/ModelHarbor")).toBe(
      false,
    );
    expect(deleteConfirmMatches("Zomcxj/LabelForge", "Zomcxj/ModelHarbor")).toBe(
      false,
    );
    expect(deleteConfirmMatches("", "Zomcxj/ModelHarbor")).toBe(false);
  });
});

describe("descriptionProblem", () => {
  it("350 字以内放行，空串表示清空", () => {
    expect(descriptionProblem("")).toBeNull();
    expect(descriptionProblem("x".repeat(350))).toBeNull();
  });

  it("超长在本地就拦下，别白跑一趟 gh", () => {
    expect(descriptionProblem("x".repeat(351))).toBe("tooLong");
  });
});

describe("repoNameProblem", () => {
  it("空名字与超长当场拦下，长度按字符数算", () => {
    expect(repoNameProblem("")).toEqual({ reason: "empty" });
    expect(repoNameProblem("   ")).toEqual({ reason: "empty" });
    expect(repoNameProblem("x".repeat(100))).toBeNull();
    expect(repoNameProblem("x".repeat(101))).toEqual({
      reason: "tooLong",
      length: 101,
    });
  });

  it("GitHub 不收的字符把那个字符指出来", () => {
    expect(repoNameProblem("我的仓库")).toEqual({
      reason: "badChar",
      char: "我",
    });
    expect(repoNameProblem("has space")).toEqual({
      reason: "badChar",
      char: " ",
    });
    // A slash belongs to a slug, and this field asks for a name.
    expect(repoNameProblem("owner/repo")).toEqual({
      reason: "badChar",
      char: "/",
    });
  });

  it("GitHub 收的名字原样放行", () => {
    expect(repoNameProblem("Verta")).toBeNull();
    expect(repoNameProblem("verta-cli_v2.1")).toBeNull();
    expect(repoNameProblem(".github")).toBeNull();
    expect(repoNameProblem("  Verta  ")).toBeNull();
  });
});

describe("cloneDestBeside", () => {
  it("落在已有项目的同一级，分隔符跟着原路径走", () => {
    expect(cloneDestBeside("F:\\work\\Verta", "ModelHarbor")).toBe(
      "F:\\work\\ModelHarbor",
    );
    expect(cloneDestBeside("/home/cxj/code/verta", "ModelHarbor")).toBe(
      "/home/cxj/code/ModelHarbor",
    );
  });

  it("结尾的斜杠不影响结果", () => {
    expect(cloneDestBeside("F:\\work\\Verta\\", "ModelHarbor")).toBe(
      "F:\\work\\ModelHarbor",
    );
  });

  it("盘根下的项目照样拼得出来", () => {
    expect(cloneDestBeside("F:\\Verta", "ModelHarbor")).toBe("F:\\ModelHarbor");
    expect(cloneDestBeside("/Verta", "ModelHarbor")).toBe("/ModelHarbor");
  });

  it("没有已有项目时不猜路径，让用户自己填", () => {
    expect(cloneDestBeside(null, "ModelHarbor")).toBe("");
    expect(cloneDestBeside("   ", "ModelHarbor")).toBe("");
    expect(cloneDestBeside("F:\\work\\Verta", "  ")).toBe("");
  });
});

describe("cloneDestFromProjects", () => {
  it("用第一条算得出上一级的条目", () => {
    expect(cloneDestFromProjects(["F:\\work\\Verta"], "ModelHarbor")).toBe(
      "F:\\work\\ModelHarbor",
    );
  });

  it("跳过算不出上一级的条目（手输了一半的名字就是这种）", () => {
    expect(
      cloneDestFromProjects(["VsProVerta", "F:\\work\\Verta"], "ModelHarbor"),
    ).toBe("F:\\work\\ModelHarbor");
  });

  it("一条都算不出来时返回空串", () => {
    expect(cloneDestFromProjects([], "ModelHarbor")).toBe("");
    expect(cloneDestFromProjects(["VsProVerta", "Verta"], "ModelHarbor")).toBe("");
  });
});
