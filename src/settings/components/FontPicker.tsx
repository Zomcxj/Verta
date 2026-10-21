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
import { useT } from "@/modules/i18n";
import { Tick02Icon, UnfoldMoreIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { useInstalledFonts } from "../lib/useInstalledFonts";

/**
 * 从本机已装字体里挑一个。
 *
 * 用可搜索的下拉（Popover + Command）而不是普通 Select：这台机器上 GDI 能列出近两百个
 * 家族名，滚着找不现实，得能边打边筛。
 *
 * 两条退路：字体列表还没读回来时给一个禁用的按钮（显示当前值），列表读不到时退回手输框
 * —— 设置项不能因为列不出字体就变成不能改。
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
  const labelOf = (option: { label: string; missing?: boolean }) =>
    option.missing
      ? `${option.label}（${t("settings.font.missing")}）`
      : option.label;
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
        {/* 模糊匹配会把 "Condensed" / "Comic Sans" 这类也捞进来，字体名清单用子串更可预测。 */}
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
                // 过滤读的是这个值：两种写法都能搜到（空串那项显示成「自动检测」）。
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
 * 只按子串筛：字体名是给人对号入座用的，模糊匹配反而把不相干的项混进来。
 * 返回值 0 就是不匹配（cmdk 的约定）。
 */
function filterBySubstring(value: string, search: string): number {
  const needle = search.trim().toLowerCase();
  if (!needle) return 1;
  return value.toLowerCase().includes(needle) ? 1 : 0;
}

/** 手输退路：只在失焦 / 回车时提交，好让人能把 "JetBrains Mono " 这种带空格的打完。 */
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