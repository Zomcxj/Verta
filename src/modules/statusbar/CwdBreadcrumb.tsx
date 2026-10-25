import { useT } from "@/modules/i18n";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { currentWorkspaceEnv } from "@/modules/workspace";
import {
  ArrowDown01Icon,
  Folder01Icon,
  Home03Icon,
  MoreHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { fitBreadcrumb } from "./lib/breadcrumbFit";
import { segmentsFromCwd } from "./lib/pathUtils";

type Props = {
  cwd: string | null;
  filePath?: string | null;
  home: string | null;
  onCd: (path: string) => void;
};

type Segment = { label: string; fullPath: string; isHome: boolean };

function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i <= 0) return "/";
  return path.slice(0, i);
}

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i === -1 ? path : path.slice(i + 1);
}

export function CwdBreadcrumb({ cwd, filePath, home, onCd }: Props) {
  const t = useT();
  // File mode: dir segments navigate; filename is the terminal leaf.
  if (filePath) {
    const dir = dirname(filePath);
    const name = basename(filePath);
    const segments = segmentsFromCwd(dir, home);
    const middle = segments.slice(1);
    return (
      <BreadcrumbTrail
        key={`${dir}|${name}`}
        leading={segments[0] ?? null}
        middles={middle}
        trailing={
          <BreadcrumbItem>
            <BreadcrumbPage className="text-foreground">{name}</BreadcrumbPage>
          </BreadcrumbItem>
        }
        onCd={onCd}
      />
    );
  }

  if (!cwd) {
    return (
      <span className="text-xs text-muted-foreground/70">
        {t("statusbar.noDirectory")}
      </span>
    );
  }

  const segments = segmentsFromCwd(cwd, home);
  const current = segments[segments.length - 1];
  const parents = segments.slice(0, -1);
  if (!current) {
    return (
      <span className="text-xs text-muted-foreground/70">
        {t("statusbar.noDirectory")}
      </span>
    );
  }
  return (
    <BreadcrumbTrail
      key={cwd}
      leading={parents[0] ?? null}
      middles={parents.slice(1)}
      trailing={
        <BreadcrumbItem>
          <CurrentSegmentDropdown
            label={current.label}
            path={current.fullPath}
            onCd={onCd}
          />
        </BreadcrumbItem>
      }
      onCd={onCd}
    />
  );
}

/**
 * A trail of folders, whose middle segments are laid out by the room the status bar has rather than
 * by a window-width breakpoint.
 *
 * The bar used to render the middle segments above 768px and hide all of them behind the "more
 * paths" button below it, so a 740px window collapsed a path that had room to be shown, and a long
 * path was scroll-clipped at every width above the breakpoint. What fits is measured instead, and
 * the trailing segments are the ones kept, since the folder the user is in lives at that end.
 *
 * The measurement reads the widths of the boxes that are on screen (the leading segment and the
 * trailing one) plus the widths of one copy of every middle segment and of the "more paths" button,
 * laid out off-screen. That copy is the same component as the visible row, so its boxes cannot drift
 * from what would be shown; it is the trick `styles/tokens.ts` uses to resolve a CSS variable, made
 * of the real markup. Only the middle segments need it, since the leading and trailing ones are
 * always painted. The caller gives this component a key that changes with the path, so a new path
 * remounts it and the widths are read again rather than reused.
 */
function BreadcrumbTrail({
  leading,
  middles,
  trailing,
  onCd,
}: {
  leading: Segment | null;
  middles: readonly Segment[];
  trailing: ReactNode;
  onCd: (path: string) => void;
}) {
  const [kept, setKept] = useState(middles.length);
  const listRef = useRef<HTMLOListElement | null>(null);
  const probeRef = useRef<HTMLSpanElement | null>(null);

  const measure = useCallback(() => {
    const list = listRef.current;
    const probe = probeRef.current;
    if (!list || !probe) return;
    const boxesOf = (root: ParentNode, part: string): number[][] =>
      [...root.querySelectorAll<HTMLElement>(`[data-part="${part}"]`)].map(
        (group) => [...group.children].map((box) => box.getBoundingClientRect().width),
      );
    const [leadingBoxes = []] = boxesOf(list, "leading");
    const [trailingBoxes = []] = boxesOf(list, "trailing");
    setKept(
      fitBreadcrumb({
        available: roomFor(list),
        gap: Number.parseFloat(getComputedStyle(list).columnGap) || 0,
        leading: leadingBoxes,
        more: boxesOf(probe, "more")[0] ?? [],
        middles: boxesOf(probe, "middle"),
        trailing: trailingBoxes,
      }),
    );
  }, []);

  useLayoutEffect(() => {
    measure();
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    // The row the nav sits in is what has to be watched, not only the list: the list is content
    // sized, so a window that gets narrower without changing the trail leaves the list's own box
    // where it was, and the fit would keep the reading it took at the last width that moved it.
    const watched = [list, list.parentElement?.parentElement ?? list].filter(
      (node, index, all) => node && all.indexOf(node) === index,
    );
    const observer = new ResizeObserver(() => measure());
    for (const node of watched) observer.observe(node);
    return () => observer.disconnect();
  }, [measure]);

  const shown = Math.max(0, Math.min(kept, middles.length));
  const collapsed = middles.slice(0, middles.length - shown);
  return (
    <Breadcrumb>
      <BreadcrumbList ref={listRef} className="gap-1 text-xs sm:gap-1.5">
        {leading ? (
          <span className="contents" data-part="leading">
            <BreadcrumbSegment
              label={leading.label}
              isHome={leading.isHome}
              onClick={() => onCd(leading.fullPath)}
            />
          </span>
        ) : null}
        {collapsed.length > 0 ? (
          <CollapsedSegments segments={collapsed} onCd={onCd} />
        ) : null}
        {middles.slice(collapsed.length).map((s) => (
          <BreadcrumbSegment
            key={s.fullPath}
            label={s.label}
            isHome={s.isHome}
            onClick={() => onCd(s.fullPath)}
          />
        ))}
        <span className="contents" data-part="trailing">
          {trailing}
        </span>
      </BreadcrumbList>
      {/* Off-screen, invisible, and out of the tab order: the widths of one copy of every middle
          segment and of the "more paths" button. It belongs to the nav rather than to the row the
          nav sits in, so that the room measurement below sees only the nav's real neighbours. Fixed
          positioning keeps it out of flow and out of any scrollable area, which is why it is not
          simply hidden off the edge of a relative parent. */}
      {middles.length > 0 ? (
        <span
          ref={probeRef}
          aria-hidden
          className="pointer-events-none invisible fixed top-0 flex items-center gap-1 whitespace-nowrap text-xs sm:gap-1.5"
          style={{ left: -10000 }}
        >
          <span className="contents" data-part="more">
            <MorePathsButton />
            <BreadcrumbSeparator className="[&>svg]:size-3" />
          </span>
          {middles.map((s) => (
            <span key={s.fullPath} className="contents" data-part="middle">
              <BreadcrumbSegment
                label={s.label}
                isHome={s.isHome}
                onClick={() => onCd(s.fullPath)}
              />
            </span>
          ))}
        </span>
      ) : null}
    </Breadcrumb>
  );
}

/**
 * The room the breadcrumb's row would give it: the row's width minus what its other children take.
 *
 * The list itself cannot answer this. It carries `w-full`, so its own width is a percentage of the
 * nav's, and the nav is a content-sized flex item with `min-w-0`: `clientWidth` on either of them is
 * whatever the trail currently happens to be, which is circular - the first measurement collapsed the
 * whole trail and then kept reading that collapsed width as the room it had. The row's width comes
 * from the layout instead, so the room is that width minus the siblings after the nav (the
 * language-server and diagnostics pills) and the gaps between the children.
 */
function roomFor(list: HTMLOListElement): number {
  const nav = list.parentElement;
  const row = nav?.parentElement;
  if (!nav || !row) return list.clientWidth;
  const siblings = [...row.children].filter((child) => child !== nav);
  const taken = siblings.reduce(
    (sum, child) => sum + child.getBoundingClientRect().width,
    0,
  );
  const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
  // The row's children sit on one line with a gap between each pair, so the nav gets what is left
  // once the others and all of those gaps are accounted for.
  return Math.max(0, row.clientWidth - taken - gap * siblings.length);
}

/** The "more paths" button on its own, so the measuring copy can carry its box without a menu. */
function MorePathsButton() {
  const t = useT();
  return (
    <button
      type="button"
      title={t("statusbar.morePaths")}
      className="flex items-center rounded-sm px-1 text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <HugeiconsIcon
        icon={MoreHorizontalIcon}
        className="size-3"
        strokeWidth={1.75}
      />
    </button>
  );
}


function BreadcrumbSegment({
  label,
  isHome,
  onClick,
}: {
  label: string;
  isHome: boolean;
  onClick: () => void;
}) {
  const t = useT();
  return (
    <>
      <BreadcrumbItem>
        <BreadcrumbLink asChild>
          <button type="button" onClick={onClick} className="cursor-pointer">
            <Badge
              variant="outline"
              className="gap-1 text-muted-foreground hover:text-foreground"
            >
              {isHome ? (
                <HugeiconsIcon
                  icon={Home03Icon}
                  className="size-3"
                  strokeWidth={1.75}
                />
              ) : null}
              {isHome ? t("statusbar.home") : label}
            </Badge>
          </button>
        </BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator className="[&>svg]:size-3" />
    </>
  );
}

function CurrentSegmentDropdown({
  label,
  path,
  onCd,
}: {
  label: string;
  path: string;
  onCd: (p: string) => void;
}) {
  const t = useT();
  const showHidden = usePreferencesStore((s) => s.showHidden);
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const dirs = await invoke<string[]>("list_subdirs", {
        path,
        showHidden,
        workspace: currentWorkspaceEnv(),
      });
      setChildren(dirs);
    } catch (e) {
      setError(String(e));
      setChildren([]);
    }
  }, [path, showHidden]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <BreadcrumbPage className="flex cursor-pointer items-center gap-1 rounded-sm px-1 py-0.5 text-foreground hover:bg-accent">
          {label === "~" ? (
            <>
              <HugeiconsIcon
                icon={Home03Icon}
                className="size-3"
                strokeWidth={1.75}
              />
              {t("statusbar.home")}
            </>
          ) : (
            label
          )}
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            className="size-3 opacity-70"
            strokeWidth={2}
          />
        </BreadcrumbPage>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
        {children === null ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {t("explorer.loading")}
          </div>
        ) : children.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {error ?? t("statusbar.noSubfolders")}
          </div>
        ) : (
          children.map((name) => (
            <DropdownMenuItem
              key={name}
              onSelect={() =>
                onCd(path.endsWith("/") ? `${path}${name}` : `${path}/${name}`)
              }
            >
              <HugeiconsIcon
                icon={Folder01Icon}
                className="size-3.5 text-muted-foreground"
                strokeWidth={1.75}
              />
              {name}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The middle segments that did not fit, behind a menu that goes straight to any of them. */
function CollapsedSegments({
  segments,
  onCd,
}: {
  segments: Segment[];
  onCd: (p: string) => void;
}) {
  const t = useT();
  return (
    <span className="contents">
      <BreadcrumbItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <MorePathsButton />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-44">
            {segments.map((s) => (
              <DropdownMenuItem
                key={s.fullPath}
                onSelect={() => onCd(s.fullPath)}
              >
                <HugeiconsIcon
                  icon={s.isHome ? Home03Icon : Folder01Icon}
                  className="size-3.5 text-muted-foreground"
                  strokeWidth={1.75}
                />
                <span className="truncate">
                  {s.isHome ? t("statusbar.home") : s.label}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </BreadcrumbItem>
      <BreadcrumbSeparator className="[&>svg]:size-3" />
    </span>
  );
}
