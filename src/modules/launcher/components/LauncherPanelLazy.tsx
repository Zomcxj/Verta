import { memo, Suspense } from "react";
import type { ComponentProps } from "react";
import { lazy } from "react";
import type { LauncherPanel as LauncherPanelType } from "./LauncherPanel";

const LauncherPanelInner = lazy(() =>
  import("./LauncherPanel").then((m) => ({ default: m.LauncherPanel })),
);

type Props = ComponentProps<typeof LauncherPanelType>;

/**
 * Memoised at the lazy boundary: the window re-renders whenever the active tab changes, and nothing
 * in the session list depends on that. What it does depend on (the active session, the workspace
 * root, the three callbacks) is unchanged by a tab switch, so the list and its rows are left alone.
 */
export const LauncherPanel = memo(function LauncherPanel(props: Props) {
  return (
    <Suspense fallback={null}>
      <LauncherPanelInner {...props} />
    </Suspense>
  );
});
