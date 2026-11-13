import { Switch } from "@/components/ui/switch";
import { WindowControls } from "@/components/WindowControls";
import { cn } from "@/lib/utils";
import { useLanguage, useT } from "@/modules/i18n";
import { WindowActivityBridge, WindowVibrancyBridge } from "@/modules/theme";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  localOffsetMinutes,
  sinceForDays,
  type TokenScope,
  type UsagePayload,
  withScope,
} from "./tokens";

/** The ranges the window offers, in days. `0` is everything on the machine. */
const RANGES = [7, 30, 90, 0] as const;
type Range = (typeof RANGES)[number];

const RANGE_KEYS = {
  7: "usage.range7",
  30: "usage.range30",
  90: "usage.range90",
  0: "usage.rangeAll",
} as const;

export function UsageApp(): JSX.Element {
  const t = useT();
  const language = useLanguage();
  const [range, setRange] = useState<Range>(30);
  const [scope, setScope] = useState<TokenScope>({
    cacheRead: true,
    cacheWrite: true,
  });
  const [payload, setPayload] = useState<UsagePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Answers can arrive out of order when a range is clicked twice quickly; only the newest one is
  // allowed to paint, or the window would show 7 days under a "90 days" button.
  const requestRef = useRef(0);

  const load = useCallback((next: Range) => {
    const ticket = ++requestRef.current;
    setLoading(true);
    setError(null);
    void invoke<UsagePayload>("agent_usage_events", {
      sinceMs: sinceForDays(next),
      offsetMinutes: localOffsetMinutes(),
      cacheRead: true,
      cacheWrite: true,
    })
      .then((answer) => {
        if (ticket !== requestRef.current) return;
        setPayload(answer);
      })
      .catch((reason) => {
        if (ticket !== requestRef.current) return;
        setError(String(reason));
      })
      .finally(() => {
        if (ticket !== requestRef.current) return;
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    load(range);
  }, [load, range]);

  // The window title is interface text, so it comes from the message table and follows the
  // language. usage.html carries a neutral title for the moment before this runs.
  useEffect(() => {
    const title = t("usage.windowTitle");
    document.title = title;
    void getCurrentWebviewWindow()
      .setTitle(title)
      .catch(() => {});
  }, [t]);

  // Scope is applied here rather than by asking Rust again: the answer already carries the raw
  // parts, and the read it would repeat is every store on the machine.
  const shown = useMemo(
    () => (payload ? withScope(payload, scope) : null),
    [payload, scope],
  );

  // The probe reads this, so what it checks is what the window drew, not a second calculation.
  useEffect(() => {
    const w = window as unknown as { __vertaUsage?: () => unknown };
    w.__vertaUsage = () =>
      shown
        ? {
            range,
            sinceMs: shown.sinceMs,
            scope: shown.scope,
            tokens: shown.tokens,
            events: shown.events,
            excludedCacheRead: shown.excludedCacheRead,
            excludedCacheWrite: shown.excludedCacheWrite,
            days: shown.days.length,
            models: shown.models.length,
            failures: shown.failures,
            // What Rust counted for the scope it was asked for, so a probe can check the two
            // implementations agree instead of assuming it.
            rustTokens: payload?.tokens ?? null,
            rustScope: payload?.scope ?? null,
          }
        : null;
  }, [shown, range, payload]);

  const format = useCallback(
    (value: number) => new Intl.NumberFormat(language).format(value),
    [language],
  );
  const compact = useCallback(
    (value: number) =>
      new Intl.NumberFormat(language, {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(value),
    [language],
  );

  const maxDay =
    shown?.days.reduce((max, day) => Math.max(max, day.tokens), 0) ?? 0;
  const maxModel =
    shown?.models.reduce((max, model) => Math.max(max, model.tokens), 0) ?? 0;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground select-none">
      <WindowVibrancyBridge />
      <header
        data-tauri-drag-region
        className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 bg-card/60 pr-0 pl-3"
      >
        <span
          className="text-[12px] font-medium text-foreground"
          data-tauri-drag-region
        >
          {t("usage.title")}
        </span>
        <div
          role="tablist"
          aria-label={t("usage.range")}
          className="ml-2 flex items-center gap-0.5 rounded-md bg-foreground/[0.05] p-0.5"
        >
          {RANGES.map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={range === value}
              disabled={loading}
              onClick={() => setRange(value)}
              className={cn(
                "cursor-pointer rounded px-2 py-0.5 text-[10.5px] outline-none transition-colors duration-[var(--dur-base)] focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60",
                range === value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(RANGE_KEYS[value])}
            </button>
          ))}
        </div>
        <button
          type="button"
          disabled={loading}
          onClick={() => load(range)}
          className="cursor-pointer rounded-md px-2 py-1 text-[11px] text-muted-foreground outline-none transition-colors duration-[var(--dur-base)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
        >
          {loading ? t("usage.loading") : t("usage.refresh")}
        </button>
        <div className="ml-auto" />
        <WindowControls closeOnly />
      </header>
      <WindowActivityBridge />

      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-border/40 px-4 py-2">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Switch
            checked={scope.cacheRead}
            onCheckedChange={(cacheRead) =>
              setScope((current) => ({ ...current, cacheRead }))
            }
          />
          {t("usage.cacheRead")}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Switch
            checked={scope.cacheWrite}
            onCheckedChange={(cacheWrite) =>
              setScope((current) => ({ ...current, cacheWrite }))
            }
          />
          {t("usage.cacheWrite")}
        </div>
      </div>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] break-words whitespace-pre-line text-destructive">
            {error}
          </div>
        ) : null}

        {shown && shown.failures.length > 0 ? (
          <div className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
            <div className="font-medium">
              {t("usage.failures", { count: shown.failures.length })}
            </div>
            <div className="mt-0.5 break-words whitespace-pre-line opacity-80">
              {shown.failures.join("\n")}
            </div>
          </div>
        ) : null}

        {!shown ? (
          <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">
            {loading
              ? t(range === 0 ? "usage.loadingAll" : "usage.loading")
              : t("usage.empty")}
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <section>
              <div className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                {t("usage.total")}
              </div>
              <div
                className="mt-0.5 text-2xl font-semibold tabular-nums"
                title={format(shown.tokens)}
              >
                {compact(shown.tokens)}
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                {t("usage.events", { count: format(shown.events) })}
                {shown.excludedCacheRead + shown.excludedCacheWrite > 0
                  ? ` · ${t("usage.excluded", {
                      read: compact(shown.excludedCacheRead),
                      write: compact(shown.excludedCacheWrite),
                    })}`
                  : ""}
              </div>
            </section>

            <section data-usage-days>
              <div className="mb-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                {t("usage.byDay")}
              </div>
              {shown.days.length === 0 ? (
                <div className="text-[11px] text-muted-foreground">
                  {t("usage.empty")}
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  {[...shown.days].reverse().map((day) => (
                    <div key={day.day} className="flex items-center gap-2">
                      <span className="w-18 shrink-0 text-[10.5px] text-muted-foreground tabular-nums">
                        {day.label.slice(5)}
                      </span>
                      <div className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-sm bg-foreground/[0.05]">
                        <div
                          className="h-full rounded-sm bg-primary/70"
                          style={{
                            width: `${maxDay > 0 ? (day.tokens / maxDay) * 100 : 0}%`,
                          }}
                        />
                      </div>
                      <span
                        className="w-16 shrink-0 text-right text-[10.5px] text-foreground tabular-nums"
                        title={format(day.tokens)}
                        data-usage-day-tokens={day.tokens}
                      >
                        {compact(day.tokens)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section data-usage-models>
              <div className="mb-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                {t("usage.byModel")}
              </div>
              {shown.models.length === 0 ? (
                <div className="text-[11px] text-muted-foreground">
                  {t("usage.empty")}
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  {shown.models.map((row) => (
                    <div
                      key={`${row.provider ?? ""}/${row.model ?? ""}`}
                      className="flex items-center gap-2"
                      data-usage-model={row.model ?? ""}
                    >
                      <span className="w-44 shrink-0 truncate text-[10.5px] text-muted-foreground">
                        {row.model ?? t("usage.unnamedModel")}
                        <span className="ml-1 opacity-60">
                          {row.provider ?? t("usage.unnamedProvider")}
                        </span>
                      </span>
                      <div className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-sm bg-foreground/[0.05]">
                        <div
                          className="h-full rounded-sm bg-primary/70"
                          style={{
                            width: `${
                              maxModel > 0 ? (row.tokens / maxModel) * 100 : 0
                            }%`,
                          }}
                        />
                      </div>
                      <span
                        className="w-20 shrink-0 text-right text-[10.5px] text-foreground tabular-nums"
                        title={format(row.tokens)}
                        data-usage-model-tokens={row.tokens}
                      >
                        {compact(row.tokens)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
