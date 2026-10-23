import { describe, expect, it } from "vitest";
import { MOD_PROP } from "@/lib/platform";
import {
  getBindingTokens,
  type KeyBinding,
  matchBinding,
  SHORTCUTS,
} from "./shortcuts";

// These tests run in the vitest node environment, where the Tauri OS plugin is
// unavailable so `IS_MAC` resolves to false. That makes the non-mac token
// branch deterministic across host platforms.

function event(over: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "",
    code: "",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...over,
  } as KeyboardEvent;
}

/** The registry is a plain table; a missing id is a test bug, not a case to assert on. */
function defaultBindingsOf(id: string): KeyBinding[] {
  const entry = SHORTCUTS.find((s) => s.id === id);
  if (!entry) throw new Error(`no shortcut in the registry: ${id}`);
  return entry.defaultBindings;
}

describe("getBindingTokens", () => {
  it("returns nothing for an undefined binding", () => {
    expect(getBindingTokens(undefined)).toEqual([]);
  });

  it("lists modifiers in order, then the key", () => {
    const binding: KeyBinding = { key: "k", ctrl: true, shift: true };
    expect(getBindingTokens(binding)).toEqual(["Ctrl", "Shift", "K"]);
  });

  it("labels space and arrow keys", () => {
    expect(getBindingTokens({ key: " ", meta: true })).toEqual([
      "Win",
      "Space",
    ]);
    expect(getBindingTokens({ key: "ArrowUp", alt: true })).toEqual([
      "Alt",
      "↑",
    ]);
  });

  it("uppercases a single-character key", () => {
    expect(getBindingTokens({ key: "c" })).toEqual(["C"]);
  });
});

describe("matchBinding", () => {
  it("matches when key and all modifiers agree", () => {
    expect(
      matchBinding(event({ key: "c", ctrlKey: true }), {
        key: "c",
        ctrl: true,
      }),
    ).toBe(true);
  });

  it("matches the key case-insensitively", () => {
    expect(
      matchBinding(event({ key: "C", ctrlKey: true }), {
        key: "c",
        ctrl: true,
      }),
    ).toBe(true);
  });

  it("fails when a required modifier is missing", () => {
    expect(matchBinding(event({ key: "c" }), { key: "c", ctrl: true })).toBe(
      false,
    );
  });

  it("fails when an extra modifier is pressed", () => {
    expect(
      matchBinding(event({ key: "c", ctrlKey: true, shiftKey: true }), {
        key: "c",
        ctrl: true,
      }),
    ).toBe(false);
  });

  it("falls back to the physical code for alt combinations", () => {
    // Alt often rewrites e.key (here to "ç"); the binding still matches via e.code.
    expect(
      matchBinding(event({ key: "ç", code: "KeyC", altKey: true }), {
        key: "c",
        alt: true,
      }),
    ).toBe(true);
    expect(
      matchBinding(event({ key: "ç", code: "KeyD", altKey: true }), {
        key: "c",
        alt: true,
      }),
    ).toBe(false);
  });

  it("falls back to the physical code for shift combinations", () => {
    // Shift turns Period into ">"; ⌘⇧. still matches the "." binding.
    expect(
      matchBinding(
        event({ key: ">", code: "Period", shiftKey: true, metaKey: true }),
        { key: ".", shift: true, meta: true },
      ),
    ).toBe(true);
    expect(
      matchBinding(
        event({ key: ">", code: "Comma", shiftKey: true, metaKey: true }),
        { key: ".", shift: true, meta: true },
      ),
    ).toBe(false);
  });

  it("does not fall back to the physical code without alt or shift", () => {
    expect(
      matchBinding(event({ key: "ç", code: "KeyC", metaKey: true }), {
        key: "c",
        meta: true,
      }),
    ).toBe(false);
  });

  it("only accepts digit keys for the jump-to-tab shortcut", () => {
    expect(
      matchBinding(event({ key: "3" }), { key: "1" }, "tab.selectByIndex"),
    ).toBe(true);
    expect(
      matchBinding(event({ key: "x" }), { key: "1" }, "tab.selectByIndex"),
    ).toBe(false);
  });
});

describe("SHORTCUTS registry", () => {
  it("binds Mod+S to editor.save", () => {
    const save = SHORTCUTS.find((s) => s.id === "editor.save");
    expect(save).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: save is asserted to be defined one line above; a ?. would turn a missing entry into a matcher failure instead of a hard error
    expect(save!.defaultBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "s", [MOD_PROP]: true }),
      ]),
    );
  });

  it("binds Alt+A to the screenshot, a chord the shell never claims", () => {
    const bindings = defaultBindingsOf("screenshot.capture");
    expect(bindings).toEqual([{ alt: true, key: "a" }]);
    expect(matchBinding(event({ key: "a", altKey: true }), bindings[0])).toBe(
      true,
    );
  });

  it("closes a tab with a shifted chord too, which the terminal cannot eat", () => {
    // A focused terminal turns the plain chord into ^W ("delete the previous
    // word") before the app ever sees it, so closing a terminal tab needs a
    // binding the shell does not claim.
    const bindings = defaultBindingsOf("tab.close");
    expect(bindings).toHaveLength(2);
    const [plain, shifted] = bindings;
    const mod = MOD_PROP === "meta" ? { metaKey: true } : { ctrlKey: true };

    expect(matchBinding(event({ key: "w", ...mod }), plain)).toBe(true);
    // Exact modifiers: the shifted chord must not be swallowed by the plain one,
    // so a config that keeps only one of the two gets exactly that one.
    expect(matchBinding(event({ key: "w", shiftKey: true, ...mod }), plain)).toBe(
      false,
    );
    expect(matchBinding(event({ key: "w", shiftKey: true, ...mod }), shifted)).toBe(
      true,
    );
  });
});
