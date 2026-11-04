import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, PREF_KEY_TO_FIELD } from "./store";

/**
 * A preference that is written and never carried back.
 *
 * A setting is written through the Tauri store and comes back through `PREF_KEY_TO_FIELD`, which is
 * the only thing that puts a written value into a window's store - the setters themselves only write.
 * A field missing from that table therefore keeps working on disk and stops working on screen:
 * reported 2026-11-04, the restore-on-launch switch sat in the same position after every click while
 * `verta-settings.json` went back and forth, because each click sends the inverse of what is on
 * screen and nothing ever moved what was on screen.
 */
describe("every preference a window holds", () => {
  it("is carried back into the store after it is written", () => {
    const fields = Object.keys(DEFAULT_PREFERENCES).sort();
    const carried = [...new Set(Object.values(PREF_KEY_TO_FIELD))].sort();
    expect(carried).toEqual(fields);
  });

  it("carries the restore-on-launch switch, which was the missing one", () => {
    expect(Object.values(PREF_KEY_TO_FIELD)).toContain("restoreTabsOnLaunch");
  });
});
