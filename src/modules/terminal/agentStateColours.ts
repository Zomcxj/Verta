/**
 * The states a live agent session can be in, as the activity store spells them.
 *
 * This lives in the terminal module because more than one surface draws it: the tab strip marks
 * its tabs with it and the session list marks its rows with it, and the colour and the wording of
 * a state have to be the same in both or the two places would describe one session two different
 * ways.
 *
 * Four colours by default, one of them a mix. `working` and `idle` are two states and one colour
 * because neither is news about the user, and `idle` and `finished` are two states and one colour
 * because a turn that ended and an agent sitting back down at its prompt are the same thing to look
 * at: green says an agent is there and nothing is in flight, and it goes on saying it until the next
 * turn starts. Which of them it is only matters to the wording, and to the store, where the latch
 * that says "an ending nobody has looked at yet" is kept - that latch is what the tray icon and the
 * notifications read, and it is not drawn here.
 *
 * Which colour a state is drawn in is a preference now (Settings, under Themes), so this file holds
 * the vocabulary and the default rather than the one answer, and there is a table per place a colour
 * lands: the dot, the bar's bed and the bar's light.
 *
 * It imports nothing, and that is on purpose. The settings store needs the default table to type and
 * to repair the preference, and the two components that draw a marker need the settings store; if
 * the default table lived beside those components instead, that would be a cycle - and the store
 * reads the table at module scope, where a cycle is not merely untidy.
 */
export type AgentStateDot =
  | "attention"
  | "working"
  | "idle"
  | "finished"
  | "background"
  | "trailing";

/**
 * The colours a state may be drawn in: Tailwind's hue names, with the weight left to the tables
 * below. A fixed set rather than a colour picker, because the marker is six pixels across and the
 * colour is what the user reads from across the window - a set that is known to be legible on both
 * the light and the dark palettes is worth more here than the freedom to choose anything.
 *
 * The order here is the order the settings draw them in.
 */
export type StateColourToken =
  | "sky"
  | "cyan"
  | "emerald"
  | "amber"
  | "orange"
  | "rose"
  | "purple"
  | "indigo";

export const STATE_COLOUR_TOKENS: readonly StateColourToken[] = [
  "sky",
  "cyan",
  "emerald",
  "amber",
  "orange",
  "rose",
  "purple",
  "indigo",
];

/**
 * The colour each state is drawn in unless the user says otherwise.
 *
 * A question is blue, work in flight is orange, an agent at rest - however it got there - is green,
 * and a turn that has ended with its tool's own work still running is purple: it is neither of the
 * two states it sits between, and every attempt to draw it as both at once said the wrong thing.
 *
 * That last one took three attempts, each decided by the person who has to look at it:
 *
 * - a gradient from orange to green read as khaki, which is what that blend is: orange (hue 48) and
 *   green (hue 162) interpolate through the yellows, and on a dot six pixels across the transition
 *   is most of the marker, so neither colour is ever seen at its own strength.
 * - a hard stop inside the dot at 65% of its radius read as the wrong way round: a ring one pixel
 *   thick on a six pixel dot is 58% of its area, so what the eye saw was a green dot with an orange
 *   middle however the two were named.
 * - an orange dot with one pixel of green around it was a ring, and was still not what was wanted.
 *
 * So it is drawn in a colour nothing else uses. The lesson written down rather than the sequence:
 * on a marker this small, two colours cannot both be read, and a state that means two things at once
 * is better told apart by a colour of its own than by a picture of the two.
 *
 * A live process the window cannot see inside shares orange with a turn in flight: orange is what
 * "an agent is here" means, and a fourth colour would make the vocabulary ask the reader for one
 * more distinction.
 */
export const DEFAULT_STATE_COLOURS: Record<AgentStateDot, StateColourToken> = {
  attention: "sky",
  working: "orange",
  idle: "emerald",
  finished: "emerald",
  background: "orange",
  trailing: "purple",
};

/**
 * How a colour is drawn, one table per place it lands.
 *
 * Written out rather than assembled from the token name: Tailwind reads class names out of the
 * source as text, so a name it cannot see does not exist. Every hue in `STATE_COLOUR_TOKENS` has to
 * appear in all three tables, and the test beside this file holds them to that - which is also what
 * keeps the names visible to the compiler that scans for them.
 *
 * The bar's bed is the same colour held back to a quarter, and its light is the colour at full
 * strength, so a row and a tab chip cannot come out as two different colours: they read the same
 * default, the same preference and these same two strings.
 */
export const DOT_BG: Record<StateColourToken, string> = {
  sky: "bg-sky-500",
  cyan: "bg-cyan-500",
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  orange: "bg-orange-500",
  rose: "bg-rose-500",
  purple: "bg-purple-500",
  indigo: "bg-indigo-500",
};

export const MARQUEE_TRACK_BG: Record<StateColourToken, string> = {
  sky: "bg-sky-500/25",
  cyan: "bg-cyan-500/25",
  emerald: "bg-emerald-500/25",
  amber: "bg-amber-500/25",
  orange: "bg-orange-500/25",
  rose: "bg-rose-500/25",
  purple: "bg-purple-500/25",
  indigo: "bg-indigo-500/25",
};

export const MARQUEE_SWEEP_BG: Record<StateColourToken, string> = {
  sky: "bg-sky-500",
  cyan: "bg-cyan-500",
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  orange: "bg-orange-500",
  rose: "bg-rose-500",
  purple: "bg-purple-500",
  indigo: "bg-indigo-500",
};
