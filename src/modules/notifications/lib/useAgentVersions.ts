import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

/** One component the bell can offer to upgrade. */
export type AgentComponent = {
  /** Stable id: `opencode`, `pi`, or `pi-extension:<package>`. */
  id: string;
  name: string;
  /** Installed version, or null when it could not be read. */
  current: string | null;
  /** Newest published version, or null when the registry could not be asked. */
  latest: string | null;
  /** Why the answer is incomplete, when it is. */
  error: string | null;
};

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
  /** Check now, replacing whatever is on screen. */
  check: () => void;
  /** Run one component's upgrade, then check again. */
  upgrade: (id: string) => void;
};

/**
 * Whether a row has a newer version.
 *
 * A comparison rather than a string test: `4.4.7` against `4.4.8` is an update, and so is a
 * published `2.2.5` against an installed `2.2.4`. Equal means up to date. Anything unparsable
 * counts as "no update to offer" - the row still lists, but the bell does not shout about it.
 */
export function hasUpdate(
  current: string | null,
  latest: string | null,
): boolean {
  if (!current || !latest) return false;
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
  return components.filter((c) => hasUpdate(c.current, c.latest));
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
    (c) => hasUpdate(c.current, c.latest) || c.error !== null,
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
  const [components, setComponents] = useState<AgentComponent[]>([]);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState<ReadonlySet<string>>(new Set());
  const [upgradeError, setUpgradeError] = useState<string | null>(null);
  const [upgraded, setUpgraded] = useState<
    { name: string; version: string | null } | null
  >(null);
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

  const upgrade = useCallback(
    (id: string) => {
      // One run per component: a second click on the same row is the same work, and the row is
      // left enabled so that the *other* rows stay usable.
      if (inFlight.current.has(id)) return;
      inFlight.current.add(id);
      setUpgrading(new Set(inFlight.current));
      setUpgradeError(null);
      // Read before the upgrade, because the row is gone from the next answer.
      const name = components.find((component) => component.id === id)?.name ?? id;
      void invoke<string>("agent_versions_upgrade", { id })
        .then(async () => {
          if (!mounted.current) return;
          // The version on screen is stale the moment the upgrade succeeds.
          setChecking(true);
          const next = await runCheck();
          if (!mounted.current) return;
          // What the component landed on, so a row leaving the list reads as success rather than
          // as the component having vanished.
          setUpgraded(upgradedNotice(name, next, id));
        })
        .catch((error: unknown) => {
          if (!mounted.current) return;
          setUpgradeError(`${name}: ${String(error)}`);
        })
        .finally(() => {
          inFlight.current.delete(id);
          if (!mounted.current) return;
          setUpgrading(new Set(inFlight.current));
          // The spinner belongs to the whole section, so it stops when the last run does.
          if (inFlight.current.size === 0) setChecking(false);
        });
    },
    [components, runCheck],
  );

  return {
    components,
    checking,
    checkError,
    upgrading,
    upgradeError,
    upgraded,
    check,
    upgrade,
  };
}
