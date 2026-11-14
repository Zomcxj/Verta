import * as React from "react"

import { cn } from "@/lib/utils"

/** How long the layer stays up after the surface starts closing, matching its own fade. */
export const FLOATING_SCRIM_EXIT_MS = 100

/**
 * The dark, blurred layer a floating surface sits on.
 *
 * The command palette is a dialog, so it has always opened over a scrim (`DialogOverlay`: a third of
 * black with an 8px backdrop blur). Menus, popovers and the commit card had none, which made a small
 * panel read as pasted onto the interface rather than floating above it. This is the same layer with
 * the same recipe, and it is up only while the surface is: the compositing budget keeps blurred
 * layers out of anything the shell mounts by default, and its allowlist carries that reason.
 *
 * `z-40` places it between the interface and the surface: `#root` is `position: static`, while
 * Radix's popper wrapper is `position: fixed` at `z-index: 50`. Pointer events pass through, because
 * Radix already makes an open menu or popover modal by blocking the page behind it, and a layer that
 * swallowed clicks would break its own dismissal.
 *
 * The caller places this inside the surface's own portal, so it leaves the DOM with that portal.
 *
 * `instant` is for a surface that takes the focus away from this window as it opens. A CSS
 * animation is ticked by the compositor, and the compositor stops ticking for a window that just
 * lost the foreground: the usage window's scrim was mounted with the right classes and sat at
 * `opacity: 0` for as long as the window kept its focus, so the layer only appeared once the window
 * was clicked. Opening at full opacity needs no tick, so it is already there in the first frame that
 * is drawn - and that frame is the one the window keeps while it is behind.
 */
export function FloatingScrim({
  open,
  instant = false,
}: {
  open: boolean
  instant?: boolean
}) {
  const [mounted, setMounted] = React.useState(open)
  React.useEffect(() => {
    if (open) {
      setMounted(true)
      return
    }
    if (instant) {
      setMounted(false)
      return
    }
    const timer = window.setTimeout(
      () => setMounted(false),
      FLOATING_SCRIM_EXIT_MS
    )
    return () => window.clearTimeout(timer)
  }, [open, instant])
  if (!mounted) return null
  if (instant) {
    return (
      <div
        data-slot="floating-scrim"
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 isolate z-40 bg-black/30 backdrop-blur-sm"
      />
    )
  }
  return (
    <div
      data-slot="floating-scrim"
      aria-hidden="true"
      className={cn(
        "pointer-events-none fixed inset-0 isolate z-40 bg-black/30 backdrop-blur-sm duration-100",
        open ? "animate-in fade-in-0" : "animate-out fade-out-0"
      )}
    />
  )
}
