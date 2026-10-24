import { describe, expect, it } from "vitest";
import {
  type Account,
  accountFrom,
  ownershipLabelKey,
  ownershipOfFolder,
  ownershipOfRepo,
  ownershipRank,
} from "./ownership";

const MINE: Account = { login: "Zomcxj", mine: ["Verta", "ModelHarbor"] };

describe("ownershipOfRepo", () => {
  it("compares the owner with the login, ignoring case and padding", () => {
    expect(ownershipOfRepo("Zomcxj", MINE)).toBe("mine");
    expect(ownershipOfRepo(" zomcxj ", MINE)).toBe("mine");
    expect(ownershipOfRepo("V-lambow", MINE)).toBe("others");
  });

  // Without a login there is nothing to compare against, and calling every row "others"
  // would be wrong for as many rows as it is right.
  it("answers unknown rather than others while the account is unknown", () => {
    expect(ownershipOfRepo("Zomcxj", null)).toBe("unknown");
    expect(ownershipOfFolder("Verta", null)).toBe("unknown");
  });
});

describe("ownershipOfFolder", () => {
  it("matches the folder name against the repositories the account owns", () => {
    expect(ownershipOfFolder("Verta", MINE)).toBe("mine");
    expect(ownershipOfFolder("verta", MINE)).toBe("mine");
    expect(ownershipOfFolder("bear_bill", MINE)).toBe("others");
  });

  it("answers unknown for a folder with no name to compare", () => {
    expect(ownershipOfFolder("", MINE)).toBe("unknown");
    expect(ownershipOfFolder("   ", MINE)).toBe("unknown");
  });
});

describe("accountFrom", () => {
  it("keeps the names of the repositories the login owns, and not the others", () => {
    const account = accountFrom("Zomcxj", [
      { owner: "Zomcxj", name: "Verta" },
      { owner: "V-lambow", name: "QTTD" },
      { owner: "zomcxj", name: "ModelHarbor" },
    ]);
    expect(account?.login).toBe("Zomcxj");
    expect(account?.mine).toEqual(["Verta", "ModelHarbor"]);
  });

  it("is null while there is no login", () => {
    expect(accountFrom(null, [])).toBeNull();
    expect(accountFrom("  ", [{ owner: "Zomcxj", name: "Verta" }])).toBeNull();
  });
});

describe("ownershipLabelKey", () => {
  it("names the three states", () => {
    expect(ownershipLabelKey("mine")).toBe("owner.mine");
    expect(ownershipLabelKey("others")).toBe("owner.others");
    expect(ownershipLabelKey("unknown")).toBe("owner.unknown");
  });
});

describe("ownershipRank", () => {
  it("orders own repositories before other people's, and unknown last", () => {
    expect(ownershipRank("mine")).toBeLessThan(ownershipRank("others"));
    expect(ownershipRank("others")).toBeLessThan(ownershipRank("unknown"));
  });
});
