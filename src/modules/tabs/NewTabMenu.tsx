import { useT } from "@/modules/i18n";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IS_WINDOWS, fmtShortcut, MOD_KEY, SHIFT_KEY } from "@/lib/platform";
import { LOCAL_WORKSPACE, type WorkspaceEnv } from "@/modules/workspace";
import {
  ComputerTerminal02Icon,
  Folder01Icon,
  GitBranchIcon,
  Globe02Icon,
  IncognitoIcon,
  PencilEdit02Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

/** 一个具体终端：本机某个 shell、默认终端，或某个发行版里的终端。 */
export type TerminalChoice = {
  shell?: string;
  env: WorkspaceEnv;
};

type ShellInfo = {
  name: string;
  path: string;
  integrated: boolean;
};

type Props = {
  onNew: () => void;
  /** 明确选一个终端（本机某个 shell，或某个发行版的终端）。 */
  onNewTerminal: (choice: TerminalChoice) => void;
  onNewBlock: () => void;
  onNewPrivate: () => void;
  onNewPreview: () => void;
  onNewEditor: () => void;
  onNewGitGraph: () => void;
  onNewProjects: () => void;
};

export function NewTabMenu({
  onNew,
  onNewTerminal,
  onNewBlock,
  onNewPrivate,
  onNewPreview,
  onNewEditor,
  onNewGitGraph,
  onNewProjects,
}: Props) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [distros, setDistros] = useState<{ name: string }[]>([]);

  // 打开菜单时才去枚举：这是一次进程探测（WSL 还要起 wsl.exe），不该拖慢启动。
  useEffect(() => {
    if (!menuOpen) return;
    let disposed = false;
    void invoke<ShellInfo[]>("pty_list_shells")
      .then((found) => {
        if (!disposed) setShells(found);
      })
      .catch(() => {
        if (!disposed) setShells([]);
      });
    if (IS_WINDOWS) {
      void invoke<{ name: string }[]>("wsl_list_distros")
        .then((found) => {
          if (!disposed) setDistros(found);
        })
        .catch(() => {
          if (!disposed) setDistros([]);
        });
    }
    return () => {
      disposed = true;
    };
  }, [menuOpen]);

  const onMenuOpenChange = (next: boolean) => {
    setMenuOpen(next);
  };

  return (
    <span className="inline-flex">
      <DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="ml-1 size-6 shrink-0 rounded-full bg-foreground/[0.06] text-muted-foreground ring-1 ring-inset ring-foreground/[0.04] hover:bg-foreground/[0.12] hover:text-foreground"
            title={t("tabs.newTab")}
          >
            <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={2} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="min-w-52 whitespace-nowrap"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
          }}
        >
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <HugeiconsIcon
                icon={ComputerTerminal02Icon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="flex-1">{t("tabs.new.terminal")}</span>
              <span className="text-xs text-muted-foreground">
                {fmtShortcut(MOD_KEY, "T")}
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-64 whitespace-nowrap">
              <DropdownMenuItem onSelect={onNew}>
                {t("tabs.new.terminalDefault")}
              </DropdownMenuItem>
              {shells.length > 0 ? <DropdownMenuSeparator /> : null}
              {shells.map((shell) => (
                <DropdownMenuItem
                  key={shell.path}
                  title={shell.path}
                  className="whitespace-nowrap"
                  onSelect={() =>
                    onNewTerminal({ shell: shell.path, env: LOCAL_WORKSPACE })
                  }
                >
                  {shell.name}
                </DropdownMenuItem>
              ))}
              {distros.length > 0 ? <DropdownMenuSeparator /> : null}
              {distros.map((distro) => (
                <DropdownMenuItem
                  key={distro.name}
                  className="whitespace-nowrap"
                  onSelect={() =>
                    onNewTerminal({ env: { kind: "wsl", distro: distro.name } })
                  }
                >
                  {t("tabs.new.terminalWsl", { distro: distro.name })}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onSelect={onNewBlock}>
            <HugeiconsIcon
              icon={ComputerTerminal02Icon}
              size={14}
              strokeWidth={1.75}
            />
            <span className="flex-1">{t("tabs.new.blocks")}</span>
            <span className="text-xs text-muted-foreground">
              {fmtShortcut(MOD_KEY, SHIFT_KEY, "T")}
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onNewPrivate}>
            <HugeiconsIcon icon={IncognitoIcon} size={14} strokeWidth={1.75} />
            <span className="flex-1">{t("tabs.new.privacy")}</span>
            <span className="text-xs text-muted-foreground">
              {fmtShortcut(MOD_KEY, "R")}
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onNewEditor}>
            <HugeiconsIcon
              icon={PencilEdit02Icon}
              size={14}
              strokeWidth={1.75}
            />
            <span className="flex-1">{t("tabs.new.editor")}</span>
            <span className="text-xs text-muted-foreground">
              {fmtShortcut(MOD_KEY, "E")}
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onNewPreview}>
            <HugeiconsIcon icon={Globe02Icon} size={14} strokeWidth={1.75} />
            <span className="flex-1">{t("tabs.new.preview")}</span>
            <span className="text-xs text-muted-foreground">
              {fmtShortcut(MOD_KEY, "P")}
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onNewGitGraph}>
            <HugeiconsIcon icon={GitBranchIcon} size={14} strokeWidth={1.75} />
            <span className="flex-1">{t("tabs.new.gitGraph")}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onNewProjects}>
            <HugeiconsIcon icon={Folder01Icon} size={14} strokeWidth={1.75} />
            <span className="flex-1">{t("tabs.new.projects")}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}