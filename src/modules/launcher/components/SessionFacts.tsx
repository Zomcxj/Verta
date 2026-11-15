import { useLanguage, useT } from "@/modules/i18n";
import { statsLine, statsOf } from "../lib/sessionStats";
import type { AgentSession } from "../lib/types";

/**
 * What one session is, as one block.
 *
 * Two surfaces read a session - the card that follows the pointer along the list, and the dialog the
 * row's menu opens - and they must not be able to disagree about it. So the block is written once,
 * with the same labels and the same data attributes, and both draw it. What differs is how much of
 * the record each one needs:
 *
 *  - the card is a glance: the id, the directory, the usage, and - only for a subagent - the session
 *    it belongs to. A top-level session has no parent, so that row would say a dash on every row of
 *    the list, and its subagents are a list that can run to fifty rows and hang a panel taller than
 *    the window off one row;
 *  - the dialog is the record: the agent, where the session came from, and every subagent it
 *    started, which is what "what do I lose by deleting this" is answered with. It scrolls, so a
 *    long list costs it nothing.
 */
export function SessionFacts({
  session,
  subagents,
  record = false,
}: {
  session: AgentSession;
  /** The sessions it started, in the list's order (newest first). Not `children`: these are rows. */
  subagents: readonly AgentSession[];
  /**
   * The whole record rather than the glance: the agent, the source, and the subagents it started.
   * Only the dialog asks for it; a card that could be hovered would keep itself open, so it cannot
   * scroll, and a list it cannot scroll is a list it should not start.
   */
  record?: boolean;
}) {
  const t = useT();
  const language = useLanguage();
  const stats = statsOf(session);
  return (
    <>
      <dl
        data-session-facts
        className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] leading-relaxed"
      >
        {record ? (
          <>
            <dt className="text-muted-foreground">{t("launcher.infoTool")}</dt>
            <dd data-session-facts-tool>{session.tool}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">{t("launcher.infoId")}</dt>
        <dd
          data-session-facts-id
          className="break-all font-mono text-[10.5px]"
        >
          {session.id}
        </dd>
        <dt className="text-muted-foreground">{t("launcher.infoDir")}</dt>
        <dd data-session-facts-dir className="break-all">
          {session.cwd}
        </dd>
        {/* Only for a subagent: a top-level session belongs to nothing, and the row said so on every
            line of the list. */}
        {session.parentId !== null ? (
          <>
            <dt className="text-muted-foreground">
              {t("launcher.infoParent")}
            </dt>
            <dd
              data-session-facts-parent
              className="break-all font-mono text-[10.5px]"
            >
              {session.parentId}
            </dd>
          </>
        ) : null}
        {record && session.distro !== null ? (
          <>
            <dt className="text-muted-foreground">
              {t("launcher.infoSource")}
            </dt>
            <dd data-session-facts-source>
              {t("launcher.sourceWsl", { distro: session.distro })}
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">{t("launcher.infoStats")}</dt>
        <dd data-session-facts-stats>
          {statsLine(stats, Date.now(), language)}
        </dd>
      </dl>

      {record && session.parentId === null ? (
        <div data-session-facts-children className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">
            {subagents.length === 0
              ? t("launcher.infoNoChildren")
              : t("launcher.infoChildren", { count: subagents.length })}
          </span>
          {subagents.length > 0 ? (
            <ul
              data-session-facts-child-list
              className="flex max-h-48 flex-col gap-0.5 overflow-y-auto rounded-md border border-border/60 p-1"
            >
              {subagents.map((child) => (
                <li
                  key={child.id}
                  data-session-facts-child={child.id}
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
    </>
  );
}
