import { native } from "@/lib/native";
import { useT } from "@/modules/i18n";
import { type WorkspaceEnv, workspaceScopeKey } from "@/modules/workspace";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  clearRepositoryTargetForWorkspace,
  repositoryTargetForWorkspace,
  repositoryTargetScope,
  setRepositoryTargetForWorkspace,
  type SourceControlRepositoryTargets,
} from "./repositoryTarget";
import {
  pickRepository,
  shouldAdoptPick,
  type DiscoveredRepo,
} from "./repoDiscovery";

type RequestCounter = { current: number };

type Params = {
  workspaceKey: string;
  isContextCurrent: (workspaceKey: string) => boolean;
  openSourceControl: () => void;
  openCommitHistoryTab: (input: {
    repoRoot: string;
    branch: string | null;
  }) => void;
};

export function useRepositoryTargeting({
  workspaceKey,
  isContextCurrent,
  openSourceControl,
  openCommitHistoryTab,
}: Params) {
  const t = useT();
  const [targets, setTargets] = useState<SourceControlRepositoryTargets>({});
  /**
   * Which folders the panel has already been placed in by discovery, per workspace root.
   *
   * The rule that matters here is the negative one: once a folder's panel has been put somewhere -
   * by discovery or by the user's own switch - a later scan must not move it. Without that, every
   * re-scan (a new session, a tab switch back, a `cd`) would put the panel back on whatever was
   * committed to most recently, silently undoing the user's choice.
   */
  const adoptedRef = useRef<Record<string, string>>({});
  const sourceControlRequestRef = useRef(0);
  const historyRequestRef = useRef(0);
  const discoveryRequestRef = useRef(0);
  const requestScope = workspaceKey;
  const requestScopeRef = useRef(requestScope);
  const repositoryTarget = useMemo(
    () => repositoryTargetForWorkspace(targets, workspaceKey),
    [targets, workspaceKey],
  );

  useEffect(() => {
    if (requestScopeRef.current === requestScope) return;
    requestScopeRef.current = requestScope;
    sourceControlRequestRef.current += 1;
    historyRequestRef.current += 1;
  }, [requestScope]);

  const resolveRepository = useCallback(
    async (path: string, requestRef: RequestCounter) => {
      const requestId = ++requestRef.current;
      try {
        const repo = await native.gitResolveRepo(path);
        if (
          requestId !== requestRef.current ||
          !isContextCurrent(workspaceKey)
        ) {
          return null;
        }
        if (!repo) {
          toast.info(t("scm.repoTarget.none"));
        }
        return repo;
      } catch (error) {
        if (
          requestId === requestRef.current &&
          isContextCurrent(workspaceKey)
        ) {
          toast.error(t("scm.repoTarget.resolveFailed"), {
            description: String(error),
          });
        }
        return null;
      }
    },
    [isContextCurrent, t, workspaceKey],
  );

  /**
   * Show the panel, on the repository the clicked folder belongs to.
   *
   * `path` is whatever was right-clicked: often a folder *above* the repository, or inside it.
   * `git_resolve_repo` answers with the repository that contains the path and with nothing when the
   * path merely holds repositories - so a folder of projects resolved to nothing, the panel said "not
   * in a git repository", and the only way in was to click the repository's own row. A folder that
   * holds repositories instead answers with the newest one, by the same rules the session scan uses.
   */
  const openInSourceControl = useCallback(
    async (path: string) => {
      const requestId = ++sourceControlRequestRef.current;
      // The user has now said which repository this folder is about. Marked as answered for the
      // same reason a scan is: a later session opening here must not move the panel back to
      // whatever was committed to most recently.
      const adopt = (repoRoot: string) => {
        adoptedRef.current[workspaceKey] = repoRoot;
        setTargets((current) =>
          setRepositoryTargetForWorkspace(current, workspaceKey, repoRoot),
        );
        openSourceControl();
      };
      let resolved: string | null = null;
      try {
        const repo = await native.gitResolveRepo(path);
        resolved = repo?.repoRoot ?? null;
      } catch (error) {
        if (requestId === sourceControlRequestRef.current && isContextCurrent(workspaceKey)) {
          toast.error(t("scm.repoTarget.resolveFailed"), { description: String(error) });
        }
        return;
      }
      if (!resolved) {
        // Not inside a repository - so it may be the folder that holds them.
        try {
          const pick = pickRepository(path, await native.gitContainedRepos(path));
          resolved = pick.kind === "none" ? null : pick.path;
        } catch {
          resolved = null;
        }
      }
      if (requestId !== sourceControlRequestRef.current || !isContextCurrent(workspaceKey)) return;
      if (!resolved) {
        toast.info(t("scm.repoTarget.none"));
        return;
      }
      adopt(resolved);
    },
    [isContextCurrent, openSourceControl, t, workspaceKey],
  );

  const openGitHistory = useCallback(
    async (path: string) => {
      const repo = await resolveRepository(path, historyRequestRef);
      if (!repo) return;
      openCommitHistoryTab({ repoRoot: repo.repoRoot, branch: repo.branch });
    },
    [openCommitHistoryTab, resolveRepository],
  );

  const followActiveContext = useCallback(() => {
    sourceControlRequestRef.current += 1;
    discoveryRequestRef.current += 1;
    // Following the context is also an answer, and a lasting one: a scan that placed the panel again
    // the next time this folder is opened would be the same silent move the user just refused.
    adoptedRef.current[workspaceKey] = "";
    setTargets((current) =>
      clearRepositoryTargetForWorkspace(current, workspaceKey),
    );
  }, [workspaceKey]);

  /**
   * Place the panel on whichever repository `folder` holds, the first time that folder is seen.
   *
   * Called when a session opens at the folder, and only then: a `cd` in a plain terminal is not the
   * user asking to be shown a project, and moving the panel there would take it out from under
   * them.
   *
   * The scope is built from the folder being opened and the environment the session runs in, not
   * from whatever the explorer is showing. The two are not the same thing at this moment: the tab
   * that will show this session is created by the same click, so a key built from the explorer's own
   * root still carries the *previous* folder - the pin landed under a scope the panel never asks
   * about, and the panel stayed empty on a folder that held three repositories.
   *
   * What is remembered is that the folder has been answered, not which path was chosen. A folder
   * whose panel is already placed - by this scan or by the user's own switch - is never touched
   * again, so switching, re-scanning or reopening the session cannot undo the choice.
   */
  const discoverForFolder = useCallback(
    async (folder: string | null, env: WorkspaceEnv) => {
      if (folder === null) return;
      const key = repositoryTargetScope(workspaceScopeKey(env), folder);
      if (key in adoptedRef.current) return;
      const requestId = ++discoveryRequestRef.current;
      let repos: DiscoveredRepo[];
      try {
        repos = await native.gitContainedRepos(folder);
      } catch {
        // A folder git cannot read is not an error to show: the panel stays as it was.
        return;
      }
      // Only the latest scan may place anything. Applying an older answer is safe - it is written
      // under the folder's own scope - but it would be answering a question already answered again.
      if (requestId !== discoveryRequestRef.current) return;
      const pick = pickRepository(folder, repos);
      if (!shouldAdoptPick(pick, key in adoptedRef.current)) return;
      if (pick.kind === "none") return;
      // Answered, whatever was chosen: the folder is asked about once.
      adoptedRef.current[key] = pick.path;
      // A folder that is itself a repository needs no pin - the panel already follows it.
      if (pick.kind !== "chosen") return;
      setTargets((current) =>
        setRepositoryTargetForWorkspace(current, key, pick.path),
      );
    },
    [],
  );

  return {
    repositoryTarget,
    openInSourceControl,
    openGitHistory,
    followActiveContext,
    discoverForFolder,
  };
}
