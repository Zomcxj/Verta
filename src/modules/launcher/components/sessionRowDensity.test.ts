import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * What a session row draws in each density, as far as text can say it.
 *
 * This repository renders no components, and one of these rules is the kind that only breaks a person:
 * the density has to come from the stored preference rather than from a constant. The rest - one line
 * against two - is measured on a screen.
 *
 * The details card is checked here for the shape that makes it move: **one** card for the list, drawn
 * next to the rows and anchored to the hovered one, positioned by its own transform. A card per row
 * (a tooltip) could only appear and disappear, which is the thing this design is not. The card itself
 * is no longer a compact-density device - `sessionHoverCard.wiring.test.ts` holds that contract.
 */
const listSource = readFileSync(
  new URL("./SessionList.tsx", import.meta.url),
  "utf8",
);
const cardSource = readFileSync(
  new URL("./SessionHoverCard.tsx", import.meta.url),
  "utf8",
);

describe("a session row's density", () => {
  it("takes the density from the stored preference", () => {
    expect(listSource).toContain("sessionListDensity");
    expect(listSource).toContain("data-session-density={density}");
  });

  it("keeps the browser's own tooltip off the row", () => {
    // Two popups on one hover, one of them saying only the title, is worse than one - and the card is
    // drawn for both densities now, so neither row may keep a native tooltip.
    expect(listSource).not.toMatch(/title=\{density/);
    expect(listSource).not.toContain("title={session.title}");
  });

  it("draws the numbers line only in the standard row", () => {
    expect(listSource).toContain('density === "standard" ? (');
  });

  it("keeps one details card for the whole list rather than one per row", () => {
    expect(listSource).not.toContain("<TooltipContent");
    expect(listSource.match(/<SessionHoverCard\b/g)?.length).toBe(1);
    // Anchored to whichever row the pointer (or the focus) is on.
    expect(listSource).toContain("onPointerEnter");
    expect(listSource).toContain("onHover?.(session, event.currentTarget)");
    expect(listSource).toContain("anchor={hovered.anchor}");
  });

  it("positions the card by its transform, so following the rows is a move", () => {
    expect(cardSource).toContain("cardPlacement(");
    expect(cardSource).toMatch(/translate\(\$\{placement\.x\}px/);
    // The content is a keyed child: the row's details are replaced while the card keeps moving.
    expect(cardSource).toContain("key={session.id}");
    expect(cardSource).toContain("data-hover-card-body");
  });

  it("shows the card where the row is, without an entrance", () => {
    // The transition has to arrive a frame after the first placement: applied in the same commit, the
    // browser interpolates `transform: none` into the placement and the card flies in from the
    // window's corner - which is what the user saw. It appears placed, and only a move to another
    // row animates.
    expect(cardSource).toMatch(/requestAnimationFrame/);
    expect(cardSource.indexOf("requestAnimationFrame")).toBeLessThan(
      cardSource.indexOf("setReady(true)"),
    );
    expect(cardSource).toMatch(/cancelAnimationFrame/);
  });

  it("paints the card in the window's own surface rather than a fixed one", () => {
    // The shared tooltip sheet is a one-line pill in the window's two theme colours, which is right
    // for a status label and wrong for three lines of text: in a light theme the row would open a
    // black block. A floating panel of text in this window is `verta-float`, which is also what gives
    // the glass theme its tint.
    const sheet =
      /data-hover-card[\s\S]*?className="([^"]*)"/.exec(cardSource)?.[1] ?? "";
    expect(sheet).toContain("verta-float");
    expect(sheet).toContain("bg-popover");
    expect(sheet).toContain("text-popover-foreground");
    // What the shared sheet sets is inverted; any of it left here would fight the surface.
    expect(sheet).not.toContain("bg-foreground");
    expect(sheet).not.toContain("text-background");
    // And it is not interactive: the row is what the pointer and the keyboard act on.
    expect(sheet).toContain("pointer-events-none");
    // As wide as its content, capped: one fixed width either crammed a long directory or floated in
    // empty space beside a short title, and a minimum width binds just as badly - it was what drew
    // the card wider than its own text.
    expect(sheet).toContain("w-max");
    expect(sheet).toMatch(/max-w-\[/);
    expect(sheet).not.toMatch(/min-w-\[/);
    expect(sheet).not.toMatch(/w-7[0-9]/);
  });
});
