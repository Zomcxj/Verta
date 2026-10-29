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
      // A toast is the one place a message is meant to be read a second time - quoted into a bug
      // report, pasted into a terminal - so it carries a way to close it and its text can be
      // selected. `touch-action` is what sonner sets for the swipe-to-dismiss gesture, and it is
      // also what stops a drag from selecting the text inside it.
      closeButton
      toastOptions={{
        classNames: {
          toast: "select-text [touch-action:auto]",
          title: "select-text",
          description: "select-text",
        },
      }}
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
