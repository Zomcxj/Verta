import { describe, expect, it } from "vitest";
import type { Tab } from "@/modules/tabs/lib/useTabs";
import { resolveControlContext } from "./context";

const tabs: Tab[] = [
  {
    id: 10,
    kind: "terminal",
    title: "agent",
    paneTree: {
      kind: "split",
      id: 11,
      dir: "row",
      children: [
        { kind: "leaf", id: 12 },
        { kind: "leaf", id: 13 },
      ],
    },
    activeLeafId: 12,
  },
  {
    id: 20,
    kind: "editor",
    title: "main.rs",
    path: "/workspace/main.rs",
    dirty: false,
    preview: false,
  },
];

describe("resolveControlContext", () => {
  it("targets the calling pane instead of ambient UI focus", () => {
    expect(resolveControlContext(tabs, 20, 13)).toEqual({
      window_id: "main",
      space_id: "default",
      tab_id: 10,
      pane_id: 13,
      source: "caller",
    });
  });

  it("falls back to the active context for an external CLI", () => {
    expect(resolveControlContext(tabs, 20)).toEqual({
      window_id: "main",
      space_id: "default",
      tab_id: 20,
      pane_id: null,
      source: "active",
    });
  });

  it("does not trust a stale caller pane id", () => {
    expect(resolveControlContext(tabs, 20, 999).source).toBe("active");
  });

  // 空间功能已经删掉，但 `space_id` 是给外部消费者（`verta-cli identify`）看的协议字段，
  // 所以它必须始终在，而不是随空间一起消失。
  it("keeps the space_id field the CLI prints, at a fixed value", () => {
    expect(resolveControlContext([], 0).space_id).toBe("default");
  });
});
