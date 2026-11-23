import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useState } from "react";
import type { MessageKey } from "@/modules/i18n";

/**
 * The update check, as the About page uses it.
 *
 * This asks the application's own command (`app_update_check`) what the newest release is, and
 * offers the release's page. It does not install anything: `bundle.createUpdaterArtifacts` is false
 * and no signing key exists for this project, so a silent self-replace is not on offer, and the
 * download is a link a person opens.
 *
 * The read happens in Rust rather than here for two reasons that are not stylistic: the window's
 * CSP has no `api.github.com` in `connect-src`, so a `fetch` from this page is refused before it
 * leaves; and the logged-in `gh` does not spend GitHub's anonymous read quota (sixty an hour).
 */

/** The shape `app_update_check` answers with (`UpdateCheck` in Rust, camelCase serialized). */
interface UpdateCheck {
  latestVersion: string | null;
  currentVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
}

export type UpdaterStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "uptodate"; version: string }
  | { kind: "available"; version: string; releaseUrl: string }
  // The repository has published nothing: not a failure, and not "up to date" either.
  | { kind: "norelease" }
  // A message key when the sentence is ours, and the text itself when it came from the network:
  // the lookup falls back to the key, so one field carries both (see `themeFiles.ts`).
  | { kind: "error"; message: MessageKey };

interface Options {
  /** Skip the throttle on automatic startup checks. */
  manual?: boolean;
}

interface HookOptions {
  /** When false, the hook does not run an automatic check on mount. */
  autoCheck?: boolean;
}

export function useUpdater({ autoCheck = true }: HookOptions = {}) {
  const [status, setStatus] = useState<UpdaterStatus>({ kind: "idle" });

  const runCheck = useCallback(async ({ manual }: Options = {}) => {
    void manual;
    setStatus({ kind: "checking" });
    try {
      const check = await invoke<UpdateCheck>("app_update_check");
      if (!check.latestVersion) {
        // Nothing published. A repository with no release is a fact, not a broken connection, and
        // saying "check failed" over it sends people looking for a problem that is not there.
        setStatus({ kind: "norelease" });
      } else if (check.hasUpdate) {
        setStatus({
          kind: "available",
          version: check.latestVersion,
          releaseUrl: check.releaseUrl,
        });
      } else {
        // A release older than this build is not news: say which version was found, so "up to date"
        // names a version rather than being a claim with nothing behind it.
        setStatus({ kind: "uptodate", version: check.latestVersion });
      }
    } catch (err) {
      setStatus({ kind: "error", message: String(err) as MessageKey });
    }
  }, []);

  /** Opens the release's page, which is where the installer is. */
  const install = useCallback(async () => {
    if (status.kind !== "available" || !status.releaseUrl) return;
    await openUrl(status.releaseUrl);
    setStatus({ kind: "idle" });
  }, [status]);

  const dismiss = useCallback(() => {
    setStatus({ kind: "idle" });
  }, []);

  useEffect(() => {
    if (!autoCheck) return;
    void runCheck();
  }, [autoCheck, runCheck]);

  return { status, check: runCheck, install, dismiss };
}
