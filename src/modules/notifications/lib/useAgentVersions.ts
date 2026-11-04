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
   * upgrade or the next check.
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
  const landed = components.find((component) => component.id === id)?.current ?? null;
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
  const [upgraded, setUpgraded] = useState<
    { name: string; version: string | null } | null
  >(null);
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
      const name = components.find((component) => component.id === id)?.name ?? id;
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
        if (landed && hasUpdate(landed.current, landed.latest, landed.compare)) {
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
   * Every row that has something newer, one after another.
   *
   * One at a time rather than all at once: each row runs a different tool's own updater, and three
   * of them installing over the same npm cache and lock files is how a click that "worked" leaves a
   * half-installed package behind. A row whose answer could not be read is not part of this: it is
   * not known to be behind, and its own button is still there to try.
   */
  const upgradeAll = useCallback(async () => {
    const ids = upgradable(components).map((component) => component.id);
    if (ids.length === 0) return;
    setUpgradedMany(null);
    let updated = 0;
    for (const id of ids) {
      if (await runUpgrade(id)) updated += 1;
    }
    if (!mounted.current) return;
    // Nothing updated is already on screen as the rows that stayed, plus the row's own failure.
    if (updated > 0) setUpgradedMany(updated);
  }, [components, runUpgrade]);

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
