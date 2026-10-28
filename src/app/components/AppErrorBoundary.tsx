import { Component, type ErrorInfo, type ReactNode } from "react";
import { useT } from "@/modules/i18n";
import { type ErrorDetail, errorDetailOf } from "./appErrorFallback";

/**
 * The last thing between one broken component and a window with nothing in it.
 *
 * React unmounts the whole tree when a render, a commit or a passive effect throws and nothing above
 * it catches. That is not a gentle failure mode: it leaves the window empty, so what the user sees is
 * the native material behind the interface and no way to tell what happened or to get back - measured
 * on the installed build as a window stuck on the acrylic, with the throw still readable in the
 * browser's own log. One component should be able to break without taking the window with it.
 *
 * The fallback is deliberately plain: no providers it might have to find, no data it has to load, and
 * nothing that could throw in turn. Reloading is the user's move, not this component's - the tree
 * behind it is gone, so a reload is the only way back, but it also stops whatever was running in a
 * terminal, and that is theirs to decide.
 */
type Props = { children: ReactNode };
type State = { detail: ErrorDetail | null };

export class AppErrorBoundary extends Component<Props, State> {
  override state: State = { detail: null };

  static getDerivedStateFromError(error: unknown): State {
    return { detail: errorDetailOf(error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Kept, rather than swallowed: the panel says what broke, and this says where. The log is the
    // only place the component stack survives - it is not written to the store or to disk.
    console.error("[verta] the interface threw:", error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.detail === null) return this.props.children;
    return <BrokenInterface detail={this.state.detail} />;
  }
}

/** The panel itself, as a function so it can read the current language like everything else. */
function BrokenInterface({ detail }: { detail: ErrorDetail }) {
  const t = useT();
  return (
    <div
      role="alert"
      className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <p className="text-sm font-medium">{t("app.error.title")}</p>
      <p className="max-w-md text-xs text-muted-foreground">
        {t("app.error.hint")}
      </p>
      <pre className="max-h-40 max-w-md overflow-auto rounded-md border border-border bg-foreground/[0.03] p-2 text-left text-[11px] text-muted-foreground">
        {detail.name}: {detail.detail}
      </pre>
      <button
        type="button"
        className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent/70"
        onClick={() => window.location.reload()}
      >
        {t("app.error.reload")}
      </button>
    </div>
  );
}