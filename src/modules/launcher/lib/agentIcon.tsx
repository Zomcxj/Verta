import {
  AiBrowserIcon,
  ChatGptIcon,
  ClaudeIcon,
  GoogleGeminiIcon,
  Grok02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { CSSProperties } from "react";

// Pi mark, from github.com/earendil-works pi-website logo.svg (MIT).
function PiIcon({
  size,
  className,
  style,
}: {
  size: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      viewBox="0 0 800 800"
      width={size}
      height={size}
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
      />
      <path fill="currentColor" d="M517.36 400H634.72V634.72H517.36Z" />
    </svg>
  );
}

// OpenCode mark, the glyph of the official wordmark embedded in @opencode/cli
// (MIT): an outer frame with a solid block in the lower half of its opening.
// The two opacities keep the mark's two-tone reading in a monochrome list.
// The viewBox is padded to 48 units around the 24x30 glyph so the ink covers
// about 62% of the box, which is what the Pi mark's own viewBox does; without
// that padding this mark reads a size larger than the others.
function OpenCodeIcon({
  size,
  className,
  style,
}: {
  size: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      viewBox="-12 -3 48 48"
      width={size}
      height={size}
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path fill="currentColor" fillOpacity="0.45" d="M18 30H6V18H18V30Z" />
      <path fill="currentColor" d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z" />
    </svg>
  );
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
 * The colour each agent's mark is drawn in.
 *
 * Every agent icon is coloured rather than inheriting the text colour: several of them sit side by
 * side in one list (the launcher, the usage window's chips and its agent table), and a column of
 * identical grey marks says nothing about which agent a row belongs to. The two marks with a
 * published colour keep it - Claude Code's clay, Gemini's blue - and the rest take a hue that no
 * neighbour already has, because a set of six colours is only useful if they can be told apart.
 *
 * One table rather than a colour per call site: the session list, the usage window and the
 * notifications all show the same agent, and three answers to "what colour is pi" would be three
 * wrong ones.
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

/** The colour this agent's mark is drawn in. */
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
  const style: CSSProperties = { color: agentColor(agent) };
  if (agent.toLowerCase() === "pi") {
    return <PiIcon size={size} className={className} style={style} />;
  }
  if (agent.toLowerCase().includes("opencode")) {
    return <OpenCodeIcon size={size} className={className} style={style} />;
  }
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
  return (
    <HugeiconsIcon
      icon={iconFor(agent)}
      size={size}
      strokeWidth={1.75}
      className={className}
      color={style.color}
    />
  );
}
