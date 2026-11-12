import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const pane = readFileSync(path.join(here, "EditorPane.tsx"), "utf8");
const preview = readFileSync(path.join(here, "MermaidPreview.tsx"), "utf8");
const diagram = readFileSync(
  path.join(here, "../../components/mermaid-diagram.tsx"),
  "utf8",
);
const chatCode = readFileSync(
  path.join(here, "../../components/chat-code.tsx"),
  "utf8",
);

describe("mermaid routing in the editor pane", () => {
  it("opens both of the diagram extensions as a diagram", () => {
    expect(pane).toMatch(/const isDiagram = fileExt === "mmd" \|\| fileExt === "mermaid";/);
    expect(pane).toMatch(/<MermaidPreview\s+content=\{diagramText\}/);
  });

  it("draws the buffer, not the file it was loaded from", () => {
    // `doc.content` only moves when a file is loaded or reloaded, so a diagram of it showed the file
    // as it was on disk while the editor beside it showed something else - the bug the side preview
    // already fixed. Subscribed only while the render stop is the one showing.
    expect(pane).toMatch(/return subscribeBuffer\(setDiagramText\);/);
    expect(pane).toMatch(/if \(!diagramRendering\) return;/);
  });

  it("keeps the source one stop away, and does not refuse the diagram of a dirty file", () => {
    // The table and the HTML page draw from disk, so a dirty buffer falls back to the source for
    // them. This one draws from the buffer, so dirty is the case it exists for: no `renderedDisabled`.
    const toggleAt = pane.indexOf("mode={diagramRendering ?");
    expect(toggleAt).toBeGreaterThan(-1);
    const toggle = pane.slice(toggleAt, pane.indexOf("/>", toggleAt));
    expect(toggle).toMatch(/setDiagramRendered\(mode === "rendered"\)/);
    expect(toggle).not.toMatch(/renderedDisabled/);
  });

  it("renders before the source editor, so the diagram is what a .mmd opens as", () => {
    const diagramAt = pane.indexOf("<MermaidPreview");
    const editorAt = pane.indexOf("<CodeMirror");
    expect(diagramAt).toBeGreaterThan(-1);
    expect(diagramAt).toBeLessThan(editorAt);
  });
});

describe("the diagram component", () => {
  it("reaches mermaid only through a dynamic import", () => {
    // The library is the largest single package the app can reach and nothing on the startup path
    // needs it; a static import here would put it in every launch (see `eager-budget`).
    expect(diagram).toMatch(/await import\("mermaid"\)/);
    expect(diagram).not.toMatch(/from "mermaid"/);
  });

  it("draws content, not a document", () => {
    expect(diagram).toMatch(/securityLevel: "strict"/);
    expect(diagram).toMatch(/startOnLoad: false/);
  });

  it("inserts the drawing the library hands back, instead of filling a container", () => {
    // `render(id, text, container)` draws inside the container and then deletes it on the way out
    // (`removeTempElements`), so a host filled that way is empty by the time the promise resolves.
    // Measured as "a .mmd opens and shows nothing", with the svg present during the await and gone
    // after it. The returned markup is parsed and inserted - never assigned as a string, and never
    // handed back to mermaid to place.
    expect(diagram).toMatch(/mermaid\.render\(id, source\)/);
    expect(diagram).not.toMatch(/mermaid\.render\(id, source, host\)/);
    expect(diagram).toMatch(/new DOMParser\(\)\.parseFromString\(svg, "text\/html"\)/);
    expect(diagram).toMatch(/host\.replaceChildren\(document\.importNode\(/);
    expect(diagram).not.toMatch(/innerHTML/);
    expect(diagram).not.toMatch(/dangerouslySetInnerHTML/);
  });

  it("draws again for a new theme, a new mode, or new source", () => {
    // `activeTheme` is a dependency without appearing in the body: the palette is read from the
    // document, and the theme is how React hears that the document changed.
    expect(diagram).toMatch(/\}, \[id, source, resolvedMode, activeTheme\]\);/);
    expect(diagram).toMatch(/readDiagramPalette\(resolvedMode\)/);
  });

  it("shows the source when the diagram cannot be drawn", () => {
    // A half-drawn diagram under an error message reads as a rendering bug; the source is what the
    // reader can act on.
    expect(diagram).toMatch(/host\.replaceChildren\(\);/);
    expect(diagram).toMatch(/editor\.mermaid\.failed/);
  });
});

describe("a mermaid fence in markdown or chat", () => {
  it("is drawn instead of highlighted", () => {
    expect(chatCode).toMatch(/if \(label === "mermaid"\) \{/);
    expect(chatCode).toMatch(/<MermaidDiagram\s+code=\{code\}/);
  });

  it("waits for the message to finish streaming first", () => {
    // While a message streams the block shows a placeholder and no code is parsed: a diagram drawn
    // from half a fence would fail on every keystroke and then redraw.
    const streamingAt = chatCode.indexOf("if (streaming) {");
    const mermaidAt = chatCode.indexOf('if (label === "mermaid") {');
    expect(streamingAt).toBeGreaterThan(-1);
    expect(streamingAt).toBeLessThan(mermaidAt);
  });

  it("keeps the copy button over the source it was written from", () => {
    expect(chatCode).toMatch(
      /<BlockChrome\s+label="mermaid"\s+code=\{code\}\s+actions=/,
    );
  });
});

describe("the diagram's zoom", () => {
  it("hangs off the view switch instead of floating over the drawing", () => {
    // The bar is where a control of the view goes - the same corner the table and the HTML page put
    // theirs in - and it is only offered while the diagram is the stop being shown.
    const toggleAt = pane.indexOf("mode={diagramRendering ?");
    const controlsAt = pane.indexOf("<ZoomControls");
    expect(toggleAt).toBeGreaterThan(-1);
    expect(controlsAt).toBeGreaterThan(toggleAt);
    expect(controlsAt).toBeLessThan(pane.indexOf("<CodeMirror"));
  });

  it("drags with the shared surface, and only once the drawing outgrows its room", () => {
    expect(diagram).toMatch(/<PanZoomSurface/);
    expect(diagram).toMatch(/draggable=\{overflows\}/);
    // Offering a drag on a drawing that already fits would promise movement that cannot happen.
    expect(diagram).toMatch(/drawing\.width > room\.width \+ 1 \|\| drawing\.height > room\.height \+ 1/);
    // The svg is still sized from its viewBox; the surface must not transform it.
    expect(diagram).toMatch(/applyDiagramZoom\(svg, zoom\)/);
    expect(diagram).not.toMatch(/style\.transform/);
  });

  it("sizes the svg the library handed back, and says so on the host", () => {
    expect(diagram).toMatch(/applyDiagramZoom\(svg, zoom\)/);
    expect(diagram).toMatch(/data-zoom=\{zoom\}/);
    // A press moves the drawing that is already on screen; a redraw produces a new svg, which is what
    // the draw counter is for.
    expect(diagram).toMatch(/\[zoom, drawn\]/);
  });

  it("hands the wheel to the surface, which takes it non-passively", () => {
    // The gesture lives in `pan-zoom` now (see its own test): one implementation for a diagram and a
    // picture, and one place that knows React's wheel listener is passive.
    expect(diagram).toMatch(/<PanZoomSurface/);
    expect(diagram).toMatch(/onZoomChange=\{onZoomChange\}/);
    expect(diagram).not.toMatch(/addEventListener\("wheel"/);
  });

  it("gives a fence its own magnification, in the block's header", () => {
    expect(chatCode).toMatch(
      /actions=\{<ZoomControls zoom=\{zoom\} onChange=\{setZoom\} \/>\}/,
    );
  });
});

describe("the diagram reader", () => {
  it("scrolls and drags rather than shrinking a tall diagram", () => {
    // The scrolling moved into the shared surface (it is the scrollport); what the reader still owns
    // is that the drawing is given the whole pane and padded, rather than being scaled to fit.
    expect(preview).toMatch(/<MermaidDiagram\s+code=\{content\}/);
    expect(preview).toMatch(/className="h-full p-6"/);
  });
});
