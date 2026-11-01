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
  /** The id being upgraded, or null. */
  upgrading: string | null;
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
  const [upgrading, setUpgrading] = useState<string | null>(null);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);
  const [upgraded, setUpgraded] = useState<
    { name: string; version: string | null } | null
  >(null);
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
      setUpgrading(id);
      setUpgradeError(null);
      setUpgraded(null);
      // Read before the upgrade, because the row is gone from the next answer.
      const name = components.find((component) => component.id === id)?.name ?? id;
      void invoke<string>("agent_versions_upgrade", { id })
        .then(async () => {
          if (!mounted.current) return;
          // The version on screen is stale the moment the upgrade succeeds.
          setChecking(true);
          const next = await runCheck();
          if (!mounted.current) return;
          setChecking(false);
          // What the component landed on, so a row leaving the list reads as success rather than
          // as the component having vanished.
          setUpgraded(upgradedNotice(name, next, id));
        })
        .catch((error: unknown) => {
          if (!mounted.current) return;
          setUpgradeError(String(error));
        })
        .finally(() => {
          if (mounted.current) setUpgrading(null);
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
