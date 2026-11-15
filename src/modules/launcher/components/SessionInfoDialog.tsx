import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/modules/i18n";
import { AgentIcon } from "../lib/agentIcon";
import type { AgentSession } from "../lib/types";
import { SessionFacts } from "./SessionFacts";

/**
 * What one session is, and what it started.
 *
 * The manage view is the only place a subagent row is drawn, and a row on its own says almost nothing:
 * an id, a title, and a badge. The question behind "manage" is *what is this and what will I lose if I
 * delete it*, and the children are half of that answer - deleting a parent takes them with it
 * (`launcher.deleteWarnChildren`), so the count and the names have to be visible before the tick, not
 * after.
 *
 * A dialog rather than a wider row: the list is the sidebar, and four more columns of numbers would
 * push the titles out. It is also the same surface a person gets from the row's context menu, so the
 * one place to read a session is one place - and the same facts block the row's hover card draws
 * (`SessionFacts`), which is what keeps the two from telling different stories about one session.
 */
export function SessionInfoDialog({
  session,
  subagents,
  open,
  onOpenChange,
}: {
  /** The session being read; null when the dialog is closed. */
  session: AgentSession | null;
  /** The sessions it started, newest first. Not `children`: this is a list of rows, not layout. */
  subagents: readonly AgentSession[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  if (session === null) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-session-info className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2">
            <AgentIcon
              agent={session.tool}
              size={15}
              className="shrink-0 text-muted-foreground"
            />
            <span className="min-w-0 truncate">{session.title}</span>
          </DialogTitle>
          <DialogDescription>
            {session.parentId === null
              ? t("launcher.infoDescription")
              : t("launcher.infoDescriptionSubagent")}
          </DialogDescription>
        </DialogHeader>

        <SessionFacts session={session} subagents={subagents} record />
      </DialogContent>
    </Dialog>
  );
}
