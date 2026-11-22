import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  pasteableTerminalText,
  readTerminalClipboard,
  writeTerminalClipboard,
} from "./terminalClipboard";

const native = vi.hoisted(() => ({
  readText: vi.fn<() => Promise<string>>(),
  writeText: vi.fn<(text: string) => Promise<void>>(),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => native);

// Only `invoke` is replaced: `isTauri` is the package's own, which reads a global that these tests
// stub, so the two branches of `readTerminalClipboard` stay the real ones.
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return {
    ...actual,
    invoke: (...args: unknown[]) => bridge.invoke(...args),
  };
});

const web = { readText: vi.fn(), writeText: vi.fn() };

const stubClipboard = (readText: () => Promise<string>) => {
  vi.stubGlobal("navigator", { clipboard: { readText } });
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("isTauri", true);
  vi.stubGlobal("navigator", { clipboard: web });
});
afterEach(() => vi.unstubAllGlobals());

describe("terminal clipboard", () => {
  it.each(["Macintosh", "Windows NT", "X11; Linux"])(
    "uses native copy and paste in the %s application without WebKit prompts",
    async (userAgent) => {
      vi.stubGlobal("navigator", { userAgent, clipboard: web });
      native.readText.mockResolvedValue("external copy");
      await expect(readTerminalClipboard()).resolves.toBe("external copy");
      await writeTerminalClipboard("terminal selection");
      expect(native.writeText).toHaveBeenCalledWith("terminal selection");
      expect(web.readText).not.toHaveBeenCalled();
      expect(web.writeText).not.toHaveBeenCalled();
    },
  );

  it("does not fall back to permission-gated web reads after an IPC failure", async () => {
    native.readText.mockRejectedValue(new Error("clipboard busy"));
    await expect(readTerminalClipboard()).resolves.toBe("");
    expect(web.readText).not.toHaveBeenCalled();
    native.readText.mockResolvedValue("retry");
    await expect(readTerminalClipboard()).resolves.toBe("retry");
  });

  it("reports failed copies instead of signaling success", async () => {
    native.writeText.mockRejectedValue(new Error("clipboard busy"));
    await expect(writeTerminalClipboard("text")).rejects.toThrow(
      "clipboard busy",
    );
    expect(web.writeText).not.toHaveBeenCalled();
  });

  it("uses browser clipboard APIs in a browser preview", async () => {
    vi.stubGlobal("isTauri", false);
    web.readText.mockResolvedValue("web");
    await expect(readTerminalClipboard()).resolves.toBe("web");
    await writeTerminalClipboard("preview");
    expect(web.writeText).toHaveBeenCalledWith("preview");
    expect(native.readText).not.toHaveBeenCalled();
    expect(native.writeText).not.toHaveBeenCalled();
  });
});

/**
 * What a paste puts in the terminal.
 *
 * The text half is what every shell wants. The image half is the only way a screenshot can reach an
 * agent - Claude Code binds Ctrl+V to "attach the clipboard image", and pasted bytes are text - so
 * the rules are: text wins when there is any, and outside the app there is no image path to ask for.
 */
describe("what a paste puts in the terminal", () => {
  it("is the clipboard's text when there is any", async () => {
    vi.stubGlobal("isTauri", false);
    stubClipboard(async () => "ls -la");
    expect(await pasteableTerminalText()).toBe("ls -la");
  });

  it("is an image's path when the clipboard holds a picture instead of text", async () => {
    // The app writes the picture to a temporary PNG and answers with its path, which is what
    // Claude Code's Ctrl+V attaches. The clipboard's text is empty, so the second half is asked.
    native.readText.mockResolvedValue("");
    bridge.invoke.mockResolvedValue("C:\\Temp\\verta-paste\\clipboard-1700000000000.png");
    await expect(pasteableTerminalText()).resolves.toBe(
      "C:\\Temp\\verta-paste\\clipboard-1700000000000.png",
    );
    expect(bridge.invoke).toHaveBeenCalledWith("clipboard_image_path");
  });

  it("is nothing when the clipboard has neither text nor an image to write", async () => {
    // The command answers `null` for a clipboard with no image on it, which is the ordinary case.
    native.readText.mockResolvedValue("");
    bridge.invoke.mockResolvedValue(null);
    expect(await pasteableTerminalText()).toBe("");
  });

  it("asks for no image path outside the app", async () => {
    vi.stubGlobal("isTauri", false);
    stubClipboard(async () => "");
    expect(await pasteableTerminalText()).toBe("");
    expect(bridge.invoke).not.toHaveBeenCalled();
  });

  it("survives a clipboard that refuses to be read", async () => {
    vi.stubGlobal("isTauri", false);
    stubClipboard(async () => {
      throw new Error("Document is not focused");
    });
    expect(await pasteableTerminalText()).toBe("");
  });

  it("survives a write that fails, reporting nothing to paste", async () => {
    native.readText.mockResolvedValue("");
    bridge.invoke.mockRejectedValue("无法写入 C:\\Temp\\verta-paste\\x.png：denied");
    expect(await pasteableTerminalText()).toBe("");
  });
});
