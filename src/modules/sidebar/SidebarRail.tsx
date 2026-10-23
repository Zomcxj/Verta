import { cn } from "@/lib/utils";
import { type MessageKey, useT } from "@/modules/i18n";
import {
  FolderTreeIcon,
  MessageMultiple01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { SidebarViewId } from "./types";

const SIDEBAR_RAIL_HEIGHT = 36;

type RailItem = {
  id: SidebarViewId;
  /** Message key, not text: the rail is the first thing a user sees. */
  label: MessageKey;
  icon: Parameters<typeof HugeiconsIcon>[0]["icon"];
};

type Props = {
  activeView: SidebarViewId;
  onSelectView: (view: SidebarViewId) => void;
};

export function SidebarRail({ activeView, onSelectView }: Props) {
  const t = useT();
  // Git is not here: it lives in the right panel, reached from the button in the
   // top-right corner (the changed-file badge moved there too).
  const items: RailItem[] = [
    { id: "launcher", label: "rail.sessions", icon: MessageMultiple01Icon },
    { id: "explorer", label: "rail.files", icon: FolderTreeIcon },
  ];

  return (
    <div
      style={{ height: SIDEBAR_RAIL_HEIGHT }}
      className="flex shrink-0 items-stretch gap-1 border-t border-border/60 bg-foreground/[0.025] px-1.5 py-1"
    >
      {items.map((item) => {
        const isActive = item.id === activeView;
        return (
          <button
            key={item.id}
            type="button"
            aria-label={t(item.label)}
            aria-pressed={isActive}
            onClick={() => onSelectView(item.id)}
            className={cn(
              "group relative flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md text-[11px] font-medium outline-none transition-colors duration-[var(--dur-base)]",
              "focus-visible:ring-2 focus-visible:ring-primary/40",
              isActive
                ? "bg-foreground/[0.07] text-foreground dark:bg-foreground/[0.09]"
                : "text-muted-foreground hover:bg-foreground/[0.045] hover:text-foreground",
            )}
          >
            <HugeiconsIcon
              icon={item.icon}
              size={14}
              strokeWidth={isActive ? 2 : 1.75}
              className="shrink-0 transition-[stroke-width] duration-[var(--dur-base)]"
            />
            <span>{t(item.label)}</span>
          </button>
        );
      })}
    </div>
  );
}
