import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useLanguage, useT } from "@/modules/i18n";
import { AgentIcon } from "../lib/agentIcon";
import { statsLine, statsOf } from "../lib/sessionStats";
import type { AgentSession } from "../lib/types";

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
 * one place to read a session is one place.
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
  const language = useLanguage();
  if (session === null) return null;
  const stats = statsOf(session);
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

        <dl
          data-session-info-fields
          className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] leading-relaxed"
        >
          <dt className="text-muted-foreground">{t("launcher.infoTool")}</dt>
          <dd data-session-info-tool>{session.tool}</dd>
          <dt className="text-muted-foreground">{t("launcher.infoId")}</dt>
          <dd data-session-info-id className="break-all font-mono text-[10.5px]">
            {session.id}
          </dd>
          <dt className="text-muted-foreground">{t("launcher.infoDir")}</dt>
          <dd className="break-all">{session.cwd}</dd>
          {session.parentId !== null ? (
            <>
              <dt className="text-muted-foreground">{t("launcher.infoParent")}</dt>
              <dd data-session-info-parent className="break-all font-mono text-[10.5px]">
                {session.parentId}
              </dd>
            </>
          ) : null}
          {session.distro !== null ? (
            <>
              <dt className="text-muted-foreground">{t("launcher.infoSource")}</dt>
              <dd>
                {t("launcher.sourceWsl", { distro: session.distro })}
              </dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">{t("launcher.infoStats")}</dt>
          <dd data-session-info-stats>
            {statsLine(stats, Date.now(), language)}
          </dd>
        </dl>

        {session.parentId === null ? (
          <div data-session-info-children className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">
              {subagents.length === 0
                ? t("launcher.infoNoChildren")
                : t("launcher.infoChildren", { count: subagents.length })}
            </span>
            {subagents.length > 0 ? (
              <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto rounded-md border border-border/60 p-1">
                {subagents.map((child) => (
                  <li
                    key={child.id}
                    data-session-info-child={child.id}
                    className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-[11px]"
                  >
                    <span className="min-w-0 flex-1 truncate">{child.title}</span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {child.id.slice(0, 8)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
