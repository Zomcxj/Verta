import {
  AiBrowserIcon,
  ChatGptIcon,
  ClaudeIcon,
  GoogleGeminiIcon,
  Grok02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

/**
 * The agents whose own mark is shipped with the app, as PNGs under `public/agents`.
 *
 * These are the products' own icons - each one is the tile the tool ships for itself, in its own
 * colours - rather than a drawing that resembles them. That matters in the one place several agents
 * are listed together: a launcher full of look-alike glyphs cannot be read at a glance, and a brand
 * mark can.
 *
 * `pi` is matched by name, not as a substring: "copilot" and "api" are not pi. The rest are matched
 * loosely because their names appear with suffixes in the stores ("dsh-desktop",
 * "workbuddy-ai").
 */
const AGENT_MARKS: { match?: string[]; exact?: string; src: string }[] = [
  { exact: "pi", src: "/agents/pi.png" },
  { match: ["opencode"], src: "/agents/opencode.png" },
  { match: ["zcode"], src: "/agents/zcode.png" },
  { match: ["workbuddy", "codebuddy"], src: "/agents/workbuddy.png" },
  { match: ["dsh", "deepseek"], src: "/agents/dsh.png" },
];

/** The shipped mark this agent is drawn with, if the app ships one. */
export function agentMark(agent: string): string | null {
  const a = agent.trim().toLowerCase();
  for (const { match, exact, src } of AGENT_MARKS) {
    if (exact && a === exact) return src;
    if (match?.some((name) => a.includes(name))) return src;
  }
  return null;
}

function iconFor(agent: string): IconSvgElement {
  const a = agent.toLowerCase();
  if (a.includes("claude")) return ClaudeIcon;
  if (a.includes("gemini")) return GoogleGeminiIcon;
  if (a.includes("grok")) return Grok02Icon;
  if (a.includes("codex") || a.includes("gpt") || a.includes("openai"))
    return ChatGptIcon;
  return AiBrowserIcon;
}

/**
 * The colour an agent is known by, whether its mark is drawn or shipped.
 *
 * Claude Code's mark is drawn rather than shipped, and it is drawn in the agent's own clay: the
 * session list, the usage window's chips and its agent table all show it next to other agents' marks
 * and a grey one reads as "no agent" rather than "Claude Code". One table rather than a colour per
 * call site - three answers to "what colour is Claude Code" would be three wrong ones.
 */
const AGENT_COLORS: { match: string[]; color: string }[] = [
  { match: ["claude"], color: "#D97757" },
  { match: ["opencode"], color: "#22C55E" },
  { match: ["zcode"], color: "#2563EB" },
  { match: ["workbuddy", "codebuddy"], color: "#F59E0B" },
  { match: ["dsh", "deepseek"], color: "#06B6D4" },
  { match: ["gemini"], color: "#4285F4" },
  { match: ["grok"], color: "#64748B" },
  { match: ["codex", "gpt", "openai"], color: "#10A37F" },
];

/** `pi` is its own name rather than a substring: "copilot" and "api" are not pi. */
const PI_COLOR = "#A855F7";

/** An agent this table has never heard of still gets a colour, so it is not the odd grey one out. */
const FALLBACK_COLOR = "#0EA5E9";

/** The colour this agent's drawn mark takes. */
export function agentColor(agent: string): string {
  const a = agent.trim().toLowerCase();
  if (a === "pi") return PI_COLOR;
  for (const { match, color } of AGENT_COLORS) {
    if (match.some((name) => a.includes(name))) return color;
  }
  return FALLBACK_COLOR;
}

export function AgentIcon({
  agent,
  size = 15,
  className,
}: {
  agent: string;
  size?: number;
  className?: string;
}) {
  if (agent.toLowerCase().includes("verta")) {
    return (
      <img
        src="/logo.png"
        alt=""
        width={size}
        height={size}
        className={className}
        style={{ width: size, height: size }}
      />
    );
  }
  const mark = agentMark(agent);
  if (mark) {
    return (
      <img
        src={mark}
        alt=""
        width={size}
        height={size}
        className={className}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <HugeiconsIcon
      icon={iconFor(agent)}
      size={size}
      strokeWidth={1.75}
      className={className}
      // Inline, not the `color` attribute: call sites pass `text-muted-foreground` and a class beats
      // an attribute, which is why these marks used to come out grey while the shipped ones did not.
      style={{ color: agentColor(agent) }}
    />
  );
}
