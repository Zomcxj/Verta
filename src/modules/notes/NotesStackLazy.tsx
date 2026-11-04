import { lazy, Suspense } from "react";
import type { ComponentProps } from "react";
import type { NotesStack as NotesStackType } from "@/modules/notes/NotesStack";

const NotesStackInner = lazy(() =>
  import("@/modules/notes/NotesStack").then((m) => ({
    default: m.NotesStack,
  })),
);

type Props = ComponentProps<typeof NotesStackType>;

export function NotesStack(props: Props) {
  if (!props.tabs.some((tab) => tab.kind === "notes" && !tab.cold)) return null;
  return (
    <Suspense fallback={null}>
      <NotesStackInner {...props} />
    </Suspense>
  );
}
