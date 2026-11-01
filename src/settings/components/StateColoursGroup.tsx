import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { type MessageKey, useT } from "@/modules/i18n";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  resetAgentStateColours,
  setAgentStateColours,
} from "@/modules/settings/store";
import {
  type AgentStateDot,
  agentStateLabelKey,
} from "@/modules/terminal/AgentStateDot";
import {
  DOT_BG,
  STATE_COLOUR_TOKENS,
  type StateColourToken,
} from "@/modules/terminal/agentStateColours";
import { SettingRow } from "./SettingRow";

/**
 * The eight hues by name, so that one swatch can be told apart from its neighbour without seeing it:
 * the row of a colour-blind user, a swatch under a screen reader and a tooltip all need the name.
 */
const COLOUR_NAME_KEY: Record<StateColourToken, MessageKey> = {
  sky: "settings.stateColours.name.sky",
  cyan: "settings.stateColours.name.cyan",
  emerald: "settings.stateColours.name.emerald",
  amber: "settings.stateColours.name.amber",
  orange: "settings.stateColours.name.orange",
  rose: "settings.stateColours.name.rose",
  purple: "settings.stateColours.name.purple",
  indigo: "settings.stateColours.name.indigo",
};

/** The states in the order the vocabulary declares them, so nothing here invents a second order. */
const STATES: readonly AgentStateDot[] = [
  "attention",
  "working",
  "idle",
  "finished",
  "background",
  "trailing",
];

/**
 * What a session's state is drawn in, chosen one state at a time.
 *
 * A swatch is painted the colour itself - `DOT_BG`, the same string the dot on a tab uses - because
 * the thing being chosen is a colour and a list of its names is not that thing. The row's label is
 * the wording the marker already announces, so the settings and the interface speak one vocabulary
 * rather than two.
 *
 * The rule for what may be chosen is the same as for what is drawn: the table has one literal class
 * name per hue, so every swatch on screen is a colour Tailwind was able to see.
 */
export function StateColoursGroup() {
  const t = useT();
  const colours = usePreferencesStore((s) => s.agentStateColours);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <Label>{t("settings.stateColours.title")}</Label>
          <span className="text-[11px] text-muted-foreground">
            {t("settings.stateColours.description")}
          </span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 text-[12px]"
          onClick={() => void resetAgentStateColours()}
        >
          {t("settings.stateColours.reset")}
        </Button>
      </div>
      {STATES.map((state) => {
        const label = t(agentStateLabelKey(state));
        return (
          <SettingRow key={state} title={label}>
            <div className="flex items-center gap-1.5">
              {STATE_COLOUR_TOKENS.map((token) => {
                const selected = colours[state] === token;
                const name = t(COLOUR_NAME_KEY[token]);
                return (
                  <input
                    key={token}
                    type="radio"
                    // One name per state, so the eight are one group of radios: the arrow keys and
                    // the "3 of 8" a screen reader announces both come from that.
                    name={`agent-state-colour-${state}`}
                    value={token}
                    checked={selected}
                    aria-label={`${label} ${name}`}
                    title={name}
                    data-colour-token={token}
                    onChange={() =>
                      void setAgentStateColours({ ...colours, [state]: token })
                    }
                    className={cn(
                      "size-4 cursor-pointer appearance-none rounded-full transition",
                      DOT_BG[token],
                      "ring-1 ring-foreground/10 hover:ring-foreground/40",
                      "checked:ring-2 checked:ring-foreground/70",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                    )}
                  />
                );
              })}
            </div>
          </SettingRow>
        );
      })}
    </div>
  );
}
