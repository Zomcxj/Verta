import { AgentIcon } from "@/modules/launcher/lib/agentIcon";
import { usePreferencesStore } from "@/modules/settings/preferences";

/**
 * The transition shown while a session opens. It **covers only the terminal area**
 * (`WorkspaceSurface` draws it inside the terminal layer rather than full screen):
 * the only thing to hide is the moment the command lands in the terminal, while the
 * sidebar, tab bar, and status bar stay visible.
 *
 * Resuming a session writes a command into the terminal, and the instant it lands the
 * line is painted there: what you see is "someone is typing on your behalf".
 * Covering that moment before the tab opens replaces it with a centered transition:
 * the icon of the agent being started in the middle (`AgentIcon`; the app's own mark
 * when the caller has nothing to name), punched once on appearance, surrounded by the
 * animation chosen in settings (Settings → Themes).
 *
 * Deliberately animating only transform / opacity: those add no extra compositing
 * layer (exactly what the layer-budget test watches), and soft edges use radial
 * gradients rather than blur. Always `pointer-events-none`, since the transition must
 * not block input either.
 */
/**
 * Whether this transition is drawn at all. `none` means the pane is left alone: the caller
 * must not hide the terminal behind it either, or the pane would go blank instead of
 * showing the terminal while the session starts.
 */
export function sessionTransitionEnabled(variant: string): boolean {
  return variant !== "none";
}

export function SessionOpeningOverlay({
  open,
  tool,
}: {
  open: boolean;
  /**
   * Which agent is being started, when the caller knows.
   *
   * The layer exists to cover the moment a resume command lands in the terminal, so what it shows
   * while it waits is the agent that is about to appear - the same mark the session row and the tab
   * chip carry. Nothing to name (an unknown tool, or a start that is not a session) falls back to the
   * app's own mark rather than to an empty box.
   */
  tool?: string | null;
}) {
  const variant = usePreferencesStore((s) => s.sessionTransition);
  if (!open || !sessionTransitionEnabled(variant)) return null;
  return (
    <div
      data-session-opening
      data-session-opening-variant={variant}
      aria-hidden="true"
      // No background of its own: the pane behind provides the surface (see the note in
      // globals.css), and the terminal is hidden while this is up.
      className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center"
    >
      {variant === "ripples" ? (
        <>
          <span className="verta-session-opening-ripple" />
          <span className="verta-session-opening-ripple" />
          <span className="verta-session-opening-ripple" />
        </>
      ) : null}
      {variant === "pulse" ? (
        <>
          <span className="verta-session-opening-pulse" />
          <span className="verta-session-opening-pulse" />
          <span className="verta-session-opening-pulse" />
        </>
      ) : null}
      {variant === "orbit" ? (
        <>
          <span className="verta-session-opening-orbit" />
          <span className="verta-session-opening-orbit is-inner" />
        </>
      ) : null}
      {variant === "bars" ? (
        <span className="verta-session-opening-bars">
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
      ) : null}
      <span className="verta-session-opening-core">
        {tool ? (
          // The agent's own mark, at 34px rather than the logo's 44: a vector glyph fills the box it
          // is given, while the app's mark is a bitmap with its own padding around it, so the same
          // number draws the icon visibly larger. `text-foreground` because this is the one mark on
          // screen - the muted colour the session rows use would read as a disabled control.
          <AgentIcon agent={tool} size={34} className="text-foreground" />
        ) : (
          <img
            src="/logo.png"
            alt=""
            width={44}
            height={44}
            className="size-11 rounded-xl"
          />
        )}
      </span>
    </div>
  );
}