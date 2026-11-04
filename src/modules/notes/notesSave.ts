/**
 * A notes tab's editor lives inside the view, but the close path runs from the app:
 * closing the tab has to write the note first, because auto-save is off for editors
 * and a notes tab has no dirty prompt of its own. The view registers its saver here
 * and the app calls it before the tab goes away.
 */
const savers = new Map<number, () => Promise<void>>();

export function registerNotesSaver(id: number, save: () => Promise<void>): void {
  savers.set(id, save);
}

export function unregisterNotesSaver(id: number): void {
  savers.delete(id);
}

/** Write the note a tab has open. Resolves when there was nothing to write, too. */
export async function saveNotesTab(id: number): Promise<void> {
  const save = savers.get(id);
  if (!save) return;
  await save();
}
