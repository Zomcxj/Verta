import { invoke } from "@tauri-apps/api/core";
import { useT } from "@/modules/i18n";
import type { AgentTool } from "@/modules/launcher";
import { useCallback, useEffect, useRef, useState } from "react";

/** One component the bell can offer to upgrade. */
export type AgentComponent = {
  /**
   * Stable id: `opencode`, `pi`, `pi-extension:<package>`, `pi-git:<source>`, or
   * `opencode-plugin:<package>`.
   */
  id: string;
  /** The tool itself, or the library's own name. */
  name: string;
  /** Which tool the row belongs to, for the row's own icon. */
  agent: AgentTool;
  /** Installed version - or the commit the checkout is on - or null when it could not be read. */
  current: string | null;
  /** Newest published version - or the commit the remote is on - or null when unreadable. */
  latest: string | null;
  /** Why the answer is incomplete, when it is. */
  error: string | null;
  /**
   * Whether `current` and `latest` are versions or commits.
   *
   * A version is ordered against another one; a commit is not, so a `revision` row is behind on any
   * difference at all rather than on being the smaller one.
   */
  compare: AgentCompare;
};

/** What a row's two values are. */
export type AgentCompare = "version" | "revision";

export type AgentVersionsState = {
  components: AgentComponent[];
  /** True while a check is in flight. */
  checking: boolean;
  /** Why the last check failed, when it did. */
  checkError: string | null;
  /**
   * The ids being upgraded right now.
   *
   * A set rather than one id, because the rows are independent: one component's upgrade must not
   * take the other rows' buttons away. Reported as "多个版本更新只能点击一个，只能按顺序更新".
   */
  upgrading: ReadonlySet<string>;
  /** The last upgrade's failure, when it failed. */
  upgradeError: string | null;
  /**
   * The component whose upgrade just succeeded, with the version it landed on.
   *
   * A row leaves the list once it is current, so without this the only trace of a successful
   * upgrade is a row disappearing - which looks exactly like a failure. Cleared by the next
   * upgrade, and by the next check the popover runs: reopening the bell is a fresh look at what
   * is installed, and a confirmation from an earlier visit is not news any more.
   */
  upgraded: { name: string; version: string | null } | null;
  /**
   * How many rows the last "update everything" updated.
   *
   * A batch leaves the list looking emptied either way, and quoting one of the rows by name (what a
   * single upgrade does) would read as if only that one had run.
   */
  upgradedMany: number | null;
  /** Check now, replacing whatever is on screen. */
  check: () => void;
  /** Run one component's upgrade, then check again. */
  upgrade: (id: string) => void;
  /** Run every component that has something newer, one after another. */
  upgradeAll: () => Promise<void>;
};

/**
 * Whether a row has a newer version.
 *
 * A comparison rather than a string test: `4.4.7` against `4.4.8` is an update, and so is a
 * published `2.2.5` against an installed `2.2.4`. Equal means up to date. Anything unparsable
 * counts as "no update to offer" - the row still lists, but the bell does not shout about it.
 *
 * A `revision` row carries commits instead, and commits have no order to compare: the two are either
 * the same commit or the checkout is behind whatever the remote is on now.
 */
export function hasUpdate(
  current: string | null,
  latest: string | null,
  compare: AgentCompare = "version",
): boolean {
  if (!current || !latest) return false;
  if (compare === "revision") return current !== latest;
  const a = current.split(".").map((part) => Number.parseInt(part, 10));
  const b = latest.split(".").map((part) => Number.parseInt(part, 10));
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right;
  }
  return false;
}

/** The rows that have a newer version published. */
export function upgradable(components: AgentComponent[]): AgentComponent[] {
  return components.filter((c) => hasUpdate(c.current, c.latest, c.compare));
}

/**
 * The rows the bell lists: a newer version published, or an answer it could not get.
 *
 * A registry that cannot be reached leaves `latest` null, and a row judged by `hasUpdate` alone
 * then drops out of the list - so a check that failed was drawn as "everything is up to date",
 * which is a claim about the tools that nothing measured. Reported as "更新失败应该保留更新按钮":
 * after a failed upgrade the row (and its button) has to stay, and the case that removes it is the
 * re-check losing the network. A row whose version could not be read is listed with its button for
 * the same reason: the action it offers - install the newest published version - is still the one
 * the user wants.
 */
export function updateRows(components: AgentComponent[]): AgentComponent[] {
  return components.filter(
    (c) => hasUpdate(c.current, c.latest, c.compare) || c.error !== null,
  );
}

/**
 * The rows a "update everything" click runs.
 *
 * The same set the list is showing, which is the point: every one of those rows has its own button on
 * screen, and this is those buttons pressed together. It used to be only the rows *known* to be
 * behind, and that is what made the button disappear in the case that needed it - reported as
 * "缺少一键更新按钮": a row whose version could not be read (an HTTP 403 from a rate-limited GitHub
 * read) is not known to be behind, so a popover holding one behind row and one unreadable row offered
 * no batch action at all. A row that could not be read still has an upgrade worth running; that is why
 * it is listed with its own button in the first place.
 */
export function batchIds(components: AgentComponent[]): string[] {
  return updateRows(components).map((component) => component.id);
}

/** What a row's missing answer amounts to, in the few words a list row has room for. */
export type UpdateReason = {
  /** `rateLimited` is the 403/429 an unauthenticated GitHub read runs into; `http` is any other
   * refusal the host named; `other` is anything with no status in it at all. */
  kind: "rateLimited" | "http" | "other";
  code: number | null;
};

export function updateReason(error: string | null): UpdateReason | null {
  if (error === null) return null;
  const code = Number.parseInt(error.match(/HTTP (\d{3})/)?.[1] ?? "", 10);
  if (Number.isNaN(code)) return { kind: "other", code: null };
  if (code === 403 || code === 429) return { kind: "rateLimited", code };
  return { kind: "http", code };
}

/** One id's outcome, as `agent_versions_upgrade_many` reports it. */
export type ComponentUpgradeResult = {
  id: string;
  ok: boolean;
  message: string;
};

/**
 * A batch's failures as one line: every name, then the first detail worth acting on.
 *
 * A batch runs several rows and any of them can fail, but the notice is a single line in a corner of
 * the window - so the names all appear (a user has to know which rows are still behind) and only the
 * first detail is quoted, with its newlines collapsed, because a stack of npm output would push the
 * popover off the screen.
 */
export function batchFailureNotice(
  failures: { name: string; message: string }[],
): { names: string; detail: string } | null {
  if (failures.length === 0) return null;
  return {
    names: failures.map((failure) => failure.name).join(", "),
    detail: (failures[0].message ?? "").replace(/\s+/g, " ").trim(),
  };
}

/**
 * What to say after a successful upgrade of `id`.
 *
 * `name` is read from the row before the upgrade runs, because the answer afterwards is the only
 * place the landed version comes from and the row may be gone entirely (an extension pi dropped,
 * for instance). The version is `null` when the row no longer appears at all, which the caller
 * renders as a plain "updated".
 */
export function upgradedNotice(
  name: string,
  components: AgentComponent[],
  id: string,
): { name: string; version: string | null } {
  const landed =
    components.find((component) => component.id === id)?.current ?? null;
  return { name, version: landed };
}

/**
 * Checks the agent tools' versions when asked, and upgrades one of them.
 *
 * Deliberately not a poll and not a background timer: the check runs when the caller asks (the
 * bell runs it once when the popover opens), because it costs a registry read per component and
 * nothing in the window needs to know before the user looks.
 */
export function useAgentVersions(): AgentVersionsState {
  const t = useT();
  const [components, setComponents] = useState<AgentComponent[]>([]);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState<ReadonlySet<string>>(new Set());
  const [upgradeError, setUpgradeError] = useState<string | null>(null);
  const [upgraded, setUpgraded] = useState<{
    name: string;
    version: string | null;
  } | null>(null);
  const [upgradedMany, setUpgradedMany] = useState<number | null>(null);
  // What is actually running, as a ref as well as state: two clicks in the same tick read the state
  // from before either landed, and the second would start a duplicate run of the same component.
  const inFlight = useRef(new Set<string>());
  // A check that lands after the component is gone must not set state.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The check as a promise, so the upgrade path can wait for the new versions before it reports
  // what the component landed on.
  const runCheck = useCallback(
    () =>
      invoke<{ components: AgentComponent[] }>("agent_versions_check")
        .then((result) => {
          const next = result?.components ?? [];
          if (mounted.current) setComponents(next);
          return next;
        })
        .catch((error: unknown) => {
          if (mounted.current) {
            // A failed check leaves the rows as they were and says why: an unreachable registry
            // must not empty the popover.
            setCheckError(String(error));
          }
          return [] as AgentComponent[];
        }),
    [],
  );

  const check = useCallback(() => {
    setChecking(true);
    setCheckError(null);
    // A confirmation belongs to the visit that produced it. The popover runs this on every open,
    // so this is what takes "updated to 5.3.3" away when the bell is opened again - without it the
    // green line stayed until the app restarted ("软件没重启会显示两个组件已更新的绿字").
    setUpgraded(null);
    setUpgradedMany(null);
    void runCheck().finally(() => {
      if (mounted.current) setChecking(false);
    });
  }, [runCheck]);

  const runUpgrade = useCallback(
    async (id: string): Promise<boolean> => {
      // One run per component: a second click on the same row is the same work, and the row is
      // left enabled so that the *other* rows stay usable.
      if (inFlight.current.has(id)) return false;
      inFlight.current.add(id);
      setUpgrading(new Set(inFlight.current));
      setUpgradeError(null);
      // A single row's run replaces whatever a batch last said.
      setUpgradedMany(null);
      // Read before the upgrade, because the row is gone from the next answer.
      const name =
        components.find((component) => component.id === id)?.name ?? id;
      try {
        await invoke<string>("agent_versions_upgrade", { id });
        if (!mounted.current) return false;
        // The version on screen is stale the moment the upgrade succeeds.
        setChecking(true);
        const next = await runCheck();
        if (!mounted.current) return false;
        // What the component landed on, so a row leaving the list reads as success rather than
        // as the component having vanished. A row that is still behind has not been updated, and
        // "updated to <the old version>" would claim a command that did not happen - opencode's
        // own updater answers without looking at a plugin configured as a path.
        const landed = next.find((component) => component.id === id);
        if (
          landed &&
          hasUpdate(landed.current, landed.latest, landed.compare)
        ) {
          setUpgraded(null);
          setUpgradeError(
            t("notifications.updates.stillBehind", {
              name,
              version: landed.current ?? "",
            }),
          );
          return false;
        }
        setUpgraded(upgradedNotice(name, next, id));
        return true;
      } catch (error: unknown) {
        if (!mounted.current) return false;
        setUpgradeError(`${name}: ${String(error)}`);
        return false;
      } finally {
        inFlight.current.delete(id);
        if (mounted.current) {
          setUpgrading(new Set(inFlight.current));
          // The spinner belongs to the whole section, so it stops when the last run does.
          if (inFlight.current.size === 0) setChecking(false);
        }
      }
    },
    [components, runCheck, t],
  );

  const upgrade = useCallback(
    (id: string) => {
      void runUpgrade(id);
    },
    [runUpgrade],
  );

  /**
   * Every row the list is showing, in one call.
   *
   * The backend decides how many commands that is: the opencode plugins are one npm project, so they
   * are one `npm install`, while `pi` and opencode's own updater are separate programs and still run
   * in turn. Doing it here, one row at a time, was two installs for two plugins - each pinning the
   * other to where it was, and each re-reading the registry afterwards.
   */
  const upgradeAll = useCallback(async () => {
    const ids = batchIds(components);
    if (ids.length === 0) return;
    setUpgradedMany(null);
    setUpgradeError(null);
    // Every row in the batch is being worked on at once, because one install covers them all.
    for (const id of ids) inFlight.current.add(id);
    setUpgrading(new Set(inFlight.current));
    setChecking(true);
    try {
      const results = await invoke<ComponentUpgradeResult[]>(
        "agent_versions_upgrade_many",
        { ids },
      );
      if (!mounted.current) return;
      const next = await runCheck();
      if (!mounted.current) return;
      const outcome = new Map(results.map((result) => [result.id, result]));
      const landed = new Map(next.map((component) => [component.id, component]));
      const failures: { name: string; message: string }[] = [];
      for (const id of ids) {
        const name = components.find((component) => component.id === id)?.name ?? id;
        const result = outcome.get(id);
        if (!result?.ok) {
          failures.push({ name, message: result?.message ?? "" });
          continue;
        }
        // The command answered, but the row is still behind: the same reading as a single upgrade,
        // and "updated to <the old version>" would claim something that did not happen.
        const component = landed.get(id);
        if (component && hasUpdate(component.current, component.latest, component.compare)) {
          failures.push({
            name,
            message: t("notifications.updates.stillBehind", {
              name,
              version: component.current ?? "",
            }),
          });
        }
      }
      const notice = batchFailureNotice(failures);
      if (notice) {
        setUpgradeError(
          t("notifications.updates.batchFailed", {
            names: notice.names,
            detail: notice.detail,
          }),
        );
      }
      const updated = ids.length - failures.length;
      if (updated > 0) setUpgradedMany(updated);
    } catch (error: unknown) {
      if (mounted.current) setUpgradeError(String(error));
    } finally {
      for (const id of ids) inFlight.current.delete(id);
      if (mounted.current) {
        setUpgrading(new Set(inFlight.current));
        setChecking(false);
      }
    }
  }, [components, runCheck, t]);

  return {
    components,
    checking,
    checkError,
    upgrading,
    upgradeError,
    upgraded,
    upgradedMany,
    check,
    upgrade,
    upgradeAll,
  };
}
