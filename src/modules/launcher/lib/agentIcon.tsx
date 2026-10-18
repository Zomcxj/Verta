import {
  AiBrowserIcon,
  ChatGptIcon,
  ClaudeIcon,
  GoogleGeminiIcon,
  Grok02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

// Pi mark, from github.com/earendil-works pi-website logo.svg (MIT).
function PiIcon({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 800 800"
      width={size}
      height={size}
      className={className}
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
}: {
  size: number;
  className?: string;
}) {
  return (
    <svg
      viewBox="-12 -3 48 48"
      width={size}
      height={size}
      className={className}
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

export function AgentIcon({
  agent,
  size = 15,
  className,
}: {
  agent: string;
  size?: number;
  className?: string;
}) {
  if (agent.toLowerCase() === "pi") {
    return <PiIcon size={size} className={className} />;
  }
  if (agent.toLowerCase().includes("opencode")) {
    return <OpenCodeIcon size={size} className={className} />;
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
    />
  );
}
