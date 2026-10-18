import { Chip } from "@/components/Chip";
import { homeRelativePath } from "@/lib/homeRelativePath";
import { useBlockController } from "@/modules/terminal/lib/blockController";
import { focusLeafInput } from "@/modules/terminal/lib/terminalSessionApi";
import {
  CommandLineIcon,
  Folder01Icon,
  GitBranchIcon,
} from "@hugeicons/core-free-icons";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { OsIcon } from "./OsIcon";
import { useGitBranch } from "./useGitBranch";
import { useSystemInfo } from "./useSystemInfo";

const ShellInput = lazy(() => import("@/modules/terminal/block/ShellInput"));

type Props = {
  isBlockTab: boolean;
  isTerminalTab: boolean;
  activeLeafId: number | null;
  cwd: string | null;
  home: string | null;
};

/**
 * The prompt bar under a block terminal tab: the context chips plus the block
 * input. It only exists for block tabs now that the in-app agent is gone.
 */
export function WorkspaceInputBar({
  isBlockTab,
  isTerminalTab,
  activeLeafId,
  cwd,
  home,
}: Props) {
  const { os, shell } = useSystemInfo();

  const controller = useBlockController(isBlockTab ? activeLeafId : null);
  const blockMode = controller?.blockMode ?? "prompt";

  // Re-resolve the branch chip when a command finishes (covers `git checkout`).
  const [promptNonce, setPromptNonce] = useState(0);
  const prevBlockMode = useRef(blockMode);
  useEffect(() => {
    if (prevBlockMode.current !== "prompt" && blockMode === "prompt") {
      setPromptNonce((n) => n + 1);
    }
    prevBlockMode.current = blockMode;
  }, [blockMode]);
  const branch = useGitBranch(isTerminalTab ? cwd : null, promptNonce);

  if (!isBlockTab) return null;

  const terminalChips = isTerminalTab ? (
    <>
      {os && <Chip tone="neutral" iconNode={<OsIcon os={os} />} title={os} />}
      {cwd && (
        <Chip tone="blue" icon={Folder01Icon} title={cwd}>
          {homeRelativePath(cwd, home)}
        </Chip>
      )}
      {branch && (
        <Chip tone="violet" icon={GitBranchIcon} title={`Branch: ${branch}`}>
          {branch}
        </Chip>
      )}
      {shell && (
        <Chip tone="emerald" icon={CommandLineIcon}>
          {shell}
        </Chip>
      )}
    </>
  ) : null;

  return (
    <div data-ai-input-bar data-state="open" className="terax-reveal">
      <div className="shrink-0 border-t border-border/60 bg-foreground/[0.02] px-3 py-2">
        <div className="flex flex-col gap-2 rounded-lg px-1 py-1">
          {terminalChips ? (
            <div className="flex flex-wrap items-center gap-1">{terminalChips}</div>
          ) : null}

          <div className="flex items-end gap-2.5">
            <div className="relative min-w-0 flex-1">
              {controller && activeLeafId != null && (
                <div>
                  {blockMode === "plain" ? (
                    <button
                      type="button"
                      className="text-sm text-muted-foreground hover:text-foreground"
                      onClick={() => focusLeafInput(activeLeafId)}
                    >
                      Type directly in the terminal
                    </button>
                  ) : (
                    <Suspense fallback={null}>
                      <ShellInput
                        leafId={activeLeafId}
                        mode={blockMode}
                        focused
                        onSubmit={controller.submitCommand}
                        onInterrupt={controller.interrupt}
                        getCwd={controller.getCwd}
                      />
                    </Suspense>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}