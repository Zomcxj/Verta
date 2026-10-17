import type { ComponentProps } from "react";
import { lazy, Suspense } from "react";
import type { LauncherPanel as LauncherPanelType } from "./LauncherPanel";

const LauncherPanelInner = lazy(() =>
  import("./LauncherPanel").then((m) => ({ default: m.LauncherPanel })),
);

type Props = ComponentProps<typeof LauncherPanelType>;

export function LauncherPanel(props: Props) {
  return (
    <Suspense fallback={null}>
      <LauncherPanelInner {...props} />
    </Suspense>
  );
}
