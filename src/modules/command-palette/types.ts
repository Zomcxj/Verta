import type { MessageKey } from "@/modules/i18n";
import type { ShortcutId } from "@/modules/shortcuts";
import type { TerminalIcon } from "@hugeicons/core-free-icons";

type PaletteIcon = typeof TerminalIcon;

export type PaletteItem = {
  id: string;
  /** Message key, resolved where the row is drawn. */
  title: MessageKey;
  /** Message key of the section heading this row belongs to. */
  group: MessageKey;
  /** Fills `{name}` for the "switch to space" command, whose target varies. */
  spaceName?: string;
  keywords?: string[];
  icon?: PaletteIcon;
  iconUrl?: string;
  shortcutId?: ShortcutId;
  trailing?: string;
  disabledReason?: string;
  run: () => void;
};

export type PaletteMode = "commands" | "history" | "content" | "help";
