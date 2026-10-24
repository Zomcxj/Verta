import { useTheme } from "@/modules/theme";
import { memo } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * Memoised: the window re-renders on every tab change, and this component is not part of that. It
 * matters more than it looks, because sonner reads the document direction with `getComputedStyle` on
 * every render of its own component, which forces a style recalculation of the whole document.
 */
export const Toaster = memo(function Toaster({ ...props }: ToasterProps) {
  const { resolvedMode } = useTheme();

  return (
    <Sonner
      theme={resolvedMode}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
});
