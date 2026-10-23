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
 * the app icon in the middle, punched once on appearance, surrounded by the animation
 * chosen in settings (Settings → Themes).
 *
 * Deliberately animating only transform / opacity: those add no extra compositing
 * layer (exactly what the layer-budget test watches), and soft edges use radial
 * gradients rather than blur. Always `pointer-events-none`, since the transition must
 * not block input either.
 */
export function SessionOpeningOverlay({ open }: { open: boolean }) {
  const variant = usePreferencesStore((s) => s.sessionTransition);
  if (!open || variant === "none") return null;
  return (
    <div
      data-session-opening
      data-session-opening-variant={variant}
      aria-hidden="true"
      className="verta-session-opening pointer-events-none absolute inset-0 z-20 flex items-center justify-center"
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
        <img
          src="/logo.png"
          alt=""
          width={44}
          height={44}
          className="size-11 rounded-xl"
        />
      </span>
    </div>
  );
}