import { useCallback } from "react";
import { cn } from "@/lib/utils";
import type { NotesTab, Tab, TabPatch } from "@/modules/tabs";
import { NotesView } from "./NotesView";

type Props = {
  tabs: Tab[];
  activeId: number;
  onUpdate: (id: number, patch: TabPatch) => void;
};

/**
 * One notes tab's layer: the view is mounted for every notes tab there is and
 * hidden per the active one, the same way the editor stack keeps its buffers.
 */
function NotesLayer({
  tab,
  visible,
  onUpdate,
}: {
  tab: NotesTab;
  visible: boolean;
  onUpdate: (id: number, patch: TabPatch) => void;
}) {
  // Stable per tab: the view's list effect would otherwise re-run on every
  // render of this layer, and each run is a directory read.
  const onChange = useCallback(
    (patch: TabPatch) => onUpdate(tab.id, patch),
    [onUpdate, tab.id],
  );
  return <NotesView tab={tab} visible={visible} onChange={onChange} />;
}

export function NotesStack({ tabs, activeId, onUpdate }: Props) {
  const notes = tabs.filter((t): t is NotesTab => t.kind === "notes" && !t.cold);
  if (notes.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {notes.map((t) => {
        const visible = t.id === activeId;
        return (
          <div
            key={t.id}
            className={cn(
              "absolute inset-0",
              !visible && "invisible pointer-events-none",
            )}
            aria-hidden={!visible}
          >
            <NotesLayer tab={t} visible={visible} onUpdate={onUpdate} />
          </div>
        );
      })}
    </div>
  );
}
