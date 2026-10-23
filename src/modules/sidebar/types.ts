/**
 * The panels selectable in the left rail. The Git view is not here: it moved to the right
 * panel, reachable only from the top-right button and the command palette, so one panel
 * never has two entry points and two sets of state.
 */
export type SidebarViewId = "explorer" | "launcher";