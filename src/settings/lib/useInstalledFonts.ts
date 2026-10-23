import { native } from "@/lib/native";
import { useEffect, useState } from "react";

/**
 * Locally installed font families, for the font dropdown in settings.
 *
 * The backend is asked once per process (the font list does not change from minute to
 * minute), and an unreadable result is recorded as `null`: callers should fall back to
 * a text field on `null` rather than drawing an empty dropdown.
 */
export type InstalledFonts = {
  /** `null` = unreadable (a dependency beyond gh is missing, the backend errored, or we
   * are running in a browser). */
  families: string[] | null;
  loading: boolean;
};

let pending: Promise<string[] | null> | null = null;

export function loadInstalledFonts(): Promise<string[] | null> {
  pending ??= native.fontsList().then(
    (families) => families,
    () => null,
  );
  return pending;
}

export function useInstalledFonts(): InstalledFonts {
  const [state, setState] = useState<InstalledFonts>({
    families: null,
    loading: true,
  });

  useEffect(() => {
    let alive = true;
    void loadInstalledFonts().then((families) => {
      if (alive) setState({ families, loading: false });
    });
    return () => {
      alive = false;
    };
  }, []);

  return state;
}
