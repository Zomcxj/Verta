import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { useLanguage, useT } from "@/modules/i18n";
import { AgentIcon, relativeTime } from "@/modules/launcher";
import { pendingAttentions, questionExcerpt } from "@/modules/notifications/lib/attentions";
import {
  batchIds,
  upgradable,
  updateReason,
  updateRows,
  useAgentVersions,
} from "@/modules/notifications/lib/useAgentVersions";
import { leafScreenTail, useAgentActivityStore } from "@/modules/terminal";
import type { Tab } from "@/modules/tabs";
import { ArrowUp01Icon, BellIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";

/**
 * The sessions waiting on the user, in one list.
 *
 * A tab marker says "one of these is waiting for you" and a glance at the strip
 * finds it; this is for when the strip is not enough: the window is small, the tab
 * is scrolled out of view, or several sessions are waiting at once and the question
 * is which one to answer first. The list is the latch (waiting since the user last
 * looked), so an item leaves the list when it is answered or read, never because a
 * timeout passed, and the button itself only exists while something is on it,
 * which keeps a window with no agents in it free of the chrome.
 */
export function NotificationBell({
  tabs,
  onJump,
}: {
  tabs: readonly Tab[];
  /** Activate the tab the session is in; the caller owns tab selection. */
  onJump: (tabId: number) => void;
}) {
  const t = useT();
  // Selected as three identities rather than as a built list: `useShallow` compares
  // the values, and a list rebuilt on every store write would defeat it.
  const slices = useAgentActivityStore(
    useShallow((state) => ({
      unseen: state.unseen,
      leafPty: state.leafPty,
      agents: state.agents,
    })),
  );
  const items = useMemo(
    () => pendingAttentions(tabs, slices),
    [tabs, slices],
  );
  const versions = useAgentVersions();
  const updates = useMemo(
    () => upgradable(versions.components),
    [versions.components],
  );
  // Checked once when the header mounts, so the badge can count an available update before the
  // popover is ever opened. Opening it checks again (see `UpdatesSection`), which is where a fresh
  // answer matters; both call the same stable callback.
  useEffect(() => {
    versions.check();
  }, [versions.check]);
  // A failure is reported in the window's own corner rather than inside the popover, which closes
  // the moment the user clicks anywhere else: the run it is about keeps going (or has just failed)
  // whatever the popover is doing. The id keeps a repeated failure to one toast instead of a stack.
  useEffect(() => {
    if (!versions.checkError) return;
    toast.error(
      t("notifications.updates.checkFailed", { error: versions.checkError }),
      { id: "agent-versions-check" },
    );
  }, [versions.checkError, t]);
  useEffect(() => {
    if (!versions.upgradeError) return;
    toast.error(
      t("notifications.updates.upgradeFailed", {
        error: versions.upgradeError,
      }),
      { id: "agent-versions-upgrade" },
    );
  }, [versions.upgradeError, t]);
  // The bell is part of the window's chrome now, not something that appears with a session: it
  // stays, and the badge counts what is inside it. A quiet window shows the plain icon.
  const count = items.length + updates.length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          title={t("notifications.title")}
          data-agent-bell
          className="relative shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={BellIcon} size={18} strokeWidth={1.75} />
          {count > 0 ? (
            <span
              data-agent-bell-count
              className="absolute -top-0.5 -right-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-semibold leading-none text-amber-950 tabular-nums"
            >
              {count > 9 ? "9+" : count}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="w-80 p-1">
        {items.length > 0 ? (
          <NotificationList items={items} onJump={onJump} />
        ) : (
          <p className="px-2.5 py-3 text-center text-[11px] text-muted-foreground">
            {t("notifications.empty")}
          </p>
        )}
        <UpdatesSection versions={versions} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The "what can be upgraded" half of the bell.
 *
 * Only rows with a newer published version are listed (the caller's choice): a row that is current
 * has nothing to do, and listing it would make the popover read like a version report rather than a
 * call to action. When nothing is behind, the section says so in one line.
 *
 * The check runs when this mounts, which is when the popover opens: it costs a registry read per
 * component, so nothing needs it before the user looks.
 */
function UpdatesSection({
  versions,
}: {
  versions: ReturnType<typeof useAgentVersions>;
}) {
  const t = useT();
  useEffect(() => {
    // On mount, which is when the popover opens: reopening re-runs it, which is the cadence we
    // want. `check` is a stable callback, so listing it keeps this to one run per open.
    versions.check();
  }, [versions.check]);
  const updates = updateRows(versions.components);
  /**
   * The batch runs every row the list is showing - the same rows whose own buttons are here - so it
   * appears whenever more than one of them is listed. Gating it on the rows *known* to be behind is
   * what made it vanish in the case that needed it: one behind row plus one row whose check was
   * refused (a 403 from a rate-limited GitHub read) left nothing to click, which is reported as
   * "缺少一键更新按钮".
   */
  const batch = batchIds(versions.components);
  /**
   * Why a row could not be read, said in the row rather than only on hover: the same two words for
   * every failure ("未知") read as "the tool has no version", while a rate-limited query is a thing
   * the user can fix by waiting or by signing `gh` in.
   */
  const reasonOf = (error: string) => {
    const reason = updateReason(error);
    if (!reason) return t("notifications.updates.unknown");
    if (reason.kind === "rateLimited") {
      return t("notifications.updates.rateLimited", {
        code: String(reason.code),
      });
    }
    if (reason.kind === "http") {
      return t("notifications.updates.httpFailed", { code: String(reason.code) });
    }
    return t("notifications.updates.unknown");
  };
  // What the batch is doing right now. One install covers every plugin, so "which row is running"
  // is not a thing during a batch - the section says how many, by name when it is one.
  const running = [...versions.upgrading].map(
    (id) => versions.components.find((component) => component.id === id)?.name ?? id,
  );
  return (
    <div className="mt-0.5 flex flex-col gap-0.5 border-t border-border/50 pt-1">
      <span className="flex items-center gap-1.5 px-2.5 pt-1 pb-1 text-[10px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          {t("notifications.updates.title")}
        </span>
        {versions.checking ? <Spinner className="size-2.5" /> : null}
        {batch.length > 1 ? (
          <Button
            size="xs"
            variant="secondary"
            data-agent-update-all
            title={t("notifications.updates.upgradeAll", {
              count: batch.length,
            })}
            // Every row it runs is disabled in turn, so the button says "busy" with the rest.
            disabled={versions.upgrading.size > 0}
            onClick={() => void versions.upgradeAll()}
            className="h-5 shrink-0 px-1.5 text-[10px] font-medium"
          >
            {t("notifications.updates.updateAll", { count: batch.length })}
          </Button>
        ) : null}
      </span>
      {running.length > 0 ? (
        // The wait is the network's: a plugin installed from git is cloned, and a slow link leaves
        // the row spinning for twenty seconds. Saying so is what turns a hang into a wait.
        <p
          data-agent-upgrading
          className="px-2.5 pb-1 text-[10px] text-muted-foreground"
        >
          {running.length === 1
            ? t("notifications.updates.upgradingOne", { name: running[0] })
            : t("notifications.updates.upgradingMany", {
                count: running.length,
              })}
        </p>
      ) : null}
      {updates.length === 0 ? (
        <p className="px-2.5 pb-1.5 text-[11px] text-muted-foreground">
          {versions.checking
            ? t("notifications.updates.checking")
            : t("notifications.updates.none")}
        </p>
      ) : (
        updates.map((component) => {
          const running = versions.upgrading.has(component.id);
          return (
            <div
              key={component.id}
              data-agent-update={component.id}
              // The reason a row could not be read in full, on hover: it is a registry or install
              // error and long, so it belongs here rather than in the row.
              title={component.error ?? undefined}
              className="flex items-center gap-2 rounded-md px-2.5 py-1.5"
            >
              {/* The tool's own mark is what tells two rows apart: one library can be installed by
                  pi and by opencode at once, and a name alone would read as the same row twice. */}
              <AgentIcon
                agent={component.agent}
                size={13}
                className="shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                {component.name}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                {component.error === null
                  ? `${component.current ?? "—"} → ${component.latest ?? "—"}`
                  : reasonOf(component.error)}
              </span>
              <Button
                size="icon-sm"
                variant="ghost"
                title={t("notifications.updates.upgrade", {
                  name: component.name,
                })}
                // Only the row that is running is disabled: the others stay clickable, so several
                // components can be updated without waiting for each one in turn.
                disabled={running}
                onClick={() => versions.upgrade(component.id)}
                className="shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {running ? (
                  // The spinner cannot carry a tooltip of its own, so the wrapper holds it.
                  <span
                    className="inline-flex"
                    title={t("notifications.updates.upgrading")}
                  >
                    <Spinner className="size-3" />
                  </span>
                ) : (
                  <HugeiconsIcon
                    icon={ArrowUp01Icon}
                    size={14}
                    strokeWidth={1.9}
                  />
                )}
              </Button>
            </div>
          );
        })
      )}
      {versions.upgradedMany !== null ? (
        <p
          data-agent-updated-many
          className="px-2.5 pb-1.5 text-[10px] text-emerald-500"
        >
          {t("notifications.updates.upgradedMany", {
            count: versions.upgradedMany,
          })}
        </p>
      ) : versions.upgraded ? (
        // The row leaves the list once it is current, so this is the confirmation: without it a
        // successful upgrade looks like the component disappearing.
        <p
          data-agent-updated
          className="px-2.5 pb-1.5 text-[10px] text-emerald-500"
        >
          {versions.upgraded.version
            ? t("notifications.updates.upgraded", {
                name: versions.upgraded.name,
                version: versions.upgraded.version,
              })
            : t("notifications.updates.upgradedNoVersion", {
                name: versions.upgraded.name,
              })}
        </p>
      ) : null}
    </div>
  );
}

function NotificationList({
  items,
  onJump,
}: {
  items: ReturnType<typeof pendingAttentions>;
  onJump: (tabId: number) => void;
}) {
  const t = useT();
  const language = useLanguage();
  // The question is what the screen shows, so it is read here rather than kept in
  // the store: nothing to keep in step, and nothing to show once the agent moves on.
  // Only mounted while the list is open, so this is not a per-tick read.
  const rows = useMemo(
    () =>
      items.map((item) => ({
        item,
        excerpt: questionExcerpt(leafScreenTail(item.leafId)),
      })),
    [items],
  );
  if (rows.length === 0) {
    return (
      <p className="px-2.5 py-3 text-center text-[11px] text-muted-foreground">
        {t("notifications.empty")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      <p className="px-2.5 pt-1.5 pb-1 text-[10px] text-muted-foreground">
        {t("notifications.title")}
      </p>
      {rows.map(({ item, excerpt }) => (
        <button
          key={item.ptyId}
          type="button"
          title={t("notifications.jump")}
          onClick={() => onJump(item.tabId)}
          className="flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left outline-none hover:bg-foreground/[0.045] focus-visible:bg-foreground/[0.06]"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {item.agent ? (
              <AgentIcon
                agent={item.agent}
                size={13}
                className="shrink-0 text-muted-foreground"
              />
            ) : null}
            <span className="min-w-0 flex-1 truncate text-xs text-foreground">
              {item.title}
            </span>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {relativeTime(Date.now(), item.sinceMs, language)}
            </span>
          </span>
          {excerpt ? (
            <span className="line-clamp-2 text-[10px] text-muted-foreground">
              {excerpt}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}