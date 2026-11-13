import { MermaidDiagram } from "@/components/mermaid-diagram";

/**
 * A `.mmd`/`.mermaid` file as the diagram it is.
 *
 * The source arrives from the tab that already read it rather than being read again here: it is the
 * same bytes, it follows the editor's buffer, and a second read would be a second copy that goes
 * stale. `EditorPane` is the one that decides which of the two views is showing, and it holds the
 * magnification because the control for it sits in that same view switch.
 *
 * Scrolls and drags rather than fits: a sequence diagram of forty messages is taller than any pane, and
 * shrinking it to the pane would make it unreadable instead of merely off-screen. The centring is
 * `safe` on purpose: a diagram zoomed past the pane's width has to overflow to the right only,
 * because overflow to the left of the scroll origin cannot be reached.
 */
export function MermaidPreview({
  content,
  zoom,
  onZoomChange,
}: {
  content: string;
  zoom: number;
  onZoomChange: (zoom: number) => void;
}) {
  // The drawing sits on a `p-6` pad that scrolls with it, so the space around it is part of what is
  // being looked at rather than a fixed frame that a zoomed drawing slides under.
  return (
    <div className="flex h-full min-h-0 flex-col">
      <MermaidDiagram
        code={content}
        zoom={zoom}
        onZoomChange={onZoomChange}
        className="p-6"
      />
    </div>
  );
}
