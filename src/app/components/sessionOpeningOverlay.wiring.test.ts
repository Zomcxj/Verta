import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The transition layer draws the icon of the agent that is starting, not the app's logo.
 *
 * Read as text, the way the other wiring tests here do: this repository renders no components, and
 * what has to hold is that the mark on the layer is chosen from the session that was opened and that
 * nobody on the way down forgets to hand it along. The failure this guards is quiet - an agent's
 * session opens under the *application's* logo, which looks deliberate and is wrong.
 */
const overlay = readFileSync(
  new URL("./SessionOpeningOverlay.tsx", import.meta.url),
  "utf8",
);
const surface = readFileSync(
  new URL("./WorkspaceSurface.tsx", import.meta.url),
  "utf8",
);
const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
const styles = readFileSync(
  new URL("../../styles/globals.css", import.meta.url),
  "utf8",
);
/**
 * The rule that lays the mark out, not the reduced-motion override that only clears its animation.
 * Both are `.verta-session-opening-core`; the layout one is the one with the box.
 */
const coreRule =
  [
    ...styles.matchAll(/\.verta-session-opening-core\s*\{([\s\S]*?)\}/g),
  ]
    .map((match) => match[1])
    .find((block) => block.includes("width: 64px")) ?? "";

describe("the session-opening layer", () => {
  it("draws the agent's own icon", () => {
    expect(overlay).toContain('from "@/modules/launcher/lib/agentIcon"');
    expect(overlay).toMatch(/<AgentIcon\s+agent=\{tool\}/);
    // The icon is the point of the layer, so it is the foreground colour rather than the muted one
    // the session rows use.
    expect(overlay).toMatch(/className="text-foreground"/);
  });

  it("keeps the app's mark for a start nothing named", () => {
    // A block tab or an unknown tool: an empty box would read as a broken layer, so the fallback is
    // the logo it used to draw for everything.
    expect(overlay).toMatch(/src="\/logo\.png"/);
    expect(overlay).toMatch(/\{tool \? \(/);
  });

  it("draws the mark on the pane, with no card behind it", () => {
    // The plate was there for the bitmap logo, which needs a surface to sit on. Behind a vector icon it
    // reads as a button that is not there, so the icon floats like the animation around it. The box
    // stays: it is what the punch animation scales.
    expect(coreRule).toMatch(/background:\s*transparent/);
    expect(coreRule).not.toMatch(/box-shadow:\s*inset/);
    expect(coreRule).toMatch(/width:\s*64px/);
    expect(coreRule).toMatch(/height:\s*64px/);
  });
});

describe("the agent the layer names", () => {
  it("travels with the session-opening state", () => {
    expect(app).toMatch(/const \[sessionOpenings, setSessionOpenings\] = useState</);
    expect(app).toMatch(/tool: string \| null/);
    // Several starts can be pending, so the tool rides on the entry rather than in one state.
    expect(app).toMatch(/addSessionOpening\(starts, leafId, tool, token\)/);
  });

  it("is handed in by every start", () => {
    // Four ways a session starts (a row, a restored tab, a project folder, a new session) and each
    // one knows its agent: the session's own tool, the tab's, or the tool the caller asked for.
    expect(app).toMatch(/showSessionOpening\(leafId, session\.tool\)/);
    expect(app).toMatch(/showSessionOpening\(tab\.activeLeafId, tabAgentIcon\(tab\)\)/);
    expect(app.match(/showSessionOpening\(leafId, tool\)/g)?.length).toBe(2);
    // Two arguments everywhere: a start added later that forgets the agent would draw the logo.
    for (const call of app.match(/showSessionOpening\([^)]*\)/g) ?? []) {
      if (call.includes("showSessionOpening = useCallback")) continue;
      expect(call).toMatch(/,\s*[^,)]+\)$/);
    }
  });

  it("reaches the layer through the workspace surface", () => {
    expect(surface).toMatch(/sessionOpeningTool: string \| null/);
    expect(surface).toMatch(
      /<SessionOpeningOverlay open=\{sessionOpening\} tool=\{sessionOpeningTool\} \/>/,
    );
    expect(app).toMatch(/sessionOpening=\{sessionOpeningOnScreenNow !== null\}/);
    expect(app).toMatch(/sessionOpeningOnScreenNow\?\.tool \?\? null/);
  });
});
