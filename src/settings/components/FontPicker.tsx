import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { fontOptions } from "@/lib/fontOptions";
import type { FontOption } from "@/lib/fontOptions";
import { useT } from "@/modules/i18n";
import { Tick02Icon, UnfoldMoreIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { useInstalledFonts } from "../lib/useInstalledFonts";

/**
 * Pick one of the locally installed fonts.
 *
 * A searchable dropdown (Popover + Command) rather than a plain Select: GDI lists
 * nearly two hundred family names on a typical machine, so scrolling for one is not
 * realistic; you have to be able to type and filter.
 *
 * Two fallbacks: while the list is still loading the button is disabled (showing the
 * current value), and if the list cannot be read we drop to a text field: a setting
 * must not become uneditable just because the fonts cannot be enumerated.
 */
export function FontPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const { families, loading } = useInstalledFonts();
  const [open, setOpen] = useState(false);

  if (loading) {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled
        className="h-8 w-56 justify-between px-2.5 text-[12px] font-normal"
      >
        <span className="truncate">{value || t("settings.font.auto")}</span>
      </Button>
    );
  }

  if (!families) {
    return (
      <div className="flex flex-col items-end gap-1">
        <FontFamilyInput value={value} onCommit={onChange} />
        <span className="text-[11px] text-muted-foreground">
          {t("settings.font.listFailed")}
        </span>
      </div>
    );
  }

  const options = fontOptions(families, value, t("settings.font.auto"));
  const labelOf = (option: FontOption) => {
    if (option.missing) return `${option.label}（${t("settings.font.missing")}）`;
    // Shipped with the app: the one entry that is guaranteed to work here, and the face every stack
    // falls back to - worth naming, because seeing it is how a silent fallback becomes visible.
    if (option.bundled) return `${option.label}（${t("settings.font.bundled")}）`;
    return option.label;
  };
  const current = options.find((option) => option.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-56 justify-between gap-2 px-2.5 text-[12px] font-normal"
        >
          <span className="truncate">
            {current ? labelOf(current) : value || t("settings.font.auto")}
          </span>
          <HugeiconsIcon
            icon={UnfoldMoreIcon}
            strokeWidth={2}
            className="size-3.5 shrink-0 opacity-50"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        {/* Fuzzy matching also drags in things like "Condensed" / "Comic Sans", so
            substring matching is more predictable for a list of font names. */}
        <Command filter={filterBySubstring}>
          <CommandInput
            placeholder={t("settings.font.search")}
            className="text-[12px]"
          />
          <CommandList>
            <CommandEmpty className="text-[12px]">
              {t("settings.font.none")}
            </CommandEmpty>
            {options.map((option) => (
              <CommandItem
                key={option.value || "__auto"}
                // Filtering reads this value, so either spelling finds the entry (the
                // empty one renders as "auto-detect").
                value={`${option.label} ${option.value}`}
                onSelect={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className="text-[12px]"
              >
                <span className="truncate">{labelOf(option)}</span>
                {option.value === value && (
                  <HugeiconsIcon
                    icon={Tick02Icon}
                    strokeWidth={2}
                    className="ml-auto size-3.5 shrink-0"
                  />
                )}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Substring match only: font names are for people matching them exactly, and fuzzy
 * matching mixes in unrelated entries. Returning 0 means no match (the cmdk contract).
 */
function filterBySubstring(value: string, search: string): number {
  const needle = search.trim().toLowerCase();
  if (!needle) return 1;
  return value.toLowerCase().includes(needle) ? 1 : 0;
}

/** Text-entry fallback: commits only on blur / Enter, so a name with a trailing space
 * like "JetBrains Mono " can still be typed out. */
function FontFamilyInput({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (v: string) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = () => {
    const next = draft.trim();
    if (next !== draft) setDraft(next);
    if (next !== value) onCommit(next);
  };

  return (
    <input
      type="text"
      value={draft}
      placeholder={t("settings.fontFamily.placeholder")}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      className="h-8 w-56 rounded-md border border-border bg-background px-2.5 text-[12px] outline-none focus:border-foreground/40"
    />
  );
}