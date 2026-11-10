import { IS_WINDOWS } from "@/lib/platform";

/**
 * The Windows spelling of a working directory a POSIX shell reported.
 *
 * The shell reports its cwd over OSC 7 and it does so at every prompt, so a translated path cannot be
 * written into the terminal once and forgotten: the next prompt would put the shell's own spelling
 * back. The answer is kept beside the spelling instead - keyed by exactly what the shell said - and
 * every ask goes through it first.
 *
 * Nothing is guessed from the text. The one shape that can be read is a drive in disguise
 * (`/c/Users/x`), which the OSC 7 parser already repairs; `/tmp`, `/usr/bin` and `/home/x` are real
 * places whose Windows form only the install's own mount table knows, so those are asked about, once
 * per spelling, and the answer is remembered - including the refusal, so a machine with no Git
 * install is asked once and not once per prompt.
 */

/** What to do with a cwd a terminal just reported. */
export type CwdDecision =
  /** Use this spelling as it stands: nothing to ask about, or the answer is already known. */
  | { kind: "use"; cwd: string }
  /** The shell has not been asked about this spelling yet; the caller asks and then re-runs. */
  | { kind: "ask" };

/** The Windows spelling of each MSYS spelling asked about; `null` is "the shell could not say". */
const recalled = new Map<string, string | null>();

/**
 * Whether a path is spelled in a way only a POSIX shell understands.
 *
 * Windows only: off it, `/tmp` is simply where the directory is (which is why the platform is a
 * parameter - the rule is what is being tested, and a test runs in node, where there is no Windows).
 * `//server/share` is excluded because that is how Windows spells a UNC path too, and a relative path
 * is nothing to ask about - `cygpath` hands it back unchanged.
 */
export function needsShellTranslation(path: string, windows: boolean = IS_WINDOWS): boolean {
  return windows && path.startsWith("/") && !path.startsWith("//");
}

/** What to do with this cwd right now, without asking anybody. */
export function decideCwd(raw: string, windows: boolean = IS_WINDOWS): CwdDecision {
  if (!needsShellTranslation(raw, windows)) return { kind: "use", cwd: raw };
  const known = recalled.get(raw);
  if (known === undefined) return { kind: "ask" };
  return { kind: "use", cwd: known ?? raw };
}

/**
 * Remembers what the shell said, and answers with the path to use.
 *
 * `null` is a real answer: the shell had nothing to say about this spelling (no Git install, or a
 * `cygpath` that refused it), so the spelling is used as it stands and never asked about again.
 */
export function rememberCwd(raw: string, windows: string | null): string {
  recalled.set(raw, windows);
  return windows ?? raw;
}

/** Forgets everything asked so far. Tests only: the answers do not change while the app is running. */
export function forgetRecalledCwds(): void {
  recalled.clear();
}
