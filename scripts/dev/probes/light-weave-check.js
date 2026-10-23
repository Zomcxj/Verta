// Verify the carbon fibre texture under the light appearance: switch to Light → pick Carbon Fiber → report the
// theme variables and the actual computed style of the surface layer (so a human can confirm it really paints
// before looking at a screenshot). It switches back on its own when done.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const buttons = () => [...document.querySelectorAll("button,[role=tab]")];
  const byText = (t) =>
    buttons().find((b) => (b.textContent || "").replace(/\s+/g, "").trim() === t);

  const tabTo = async (name) => {
    const el = [...document.querySelectorAll('[role="tab"]')].find(
      (x) => (x.textContent || "").trim() === name,
    );
    if (!el) return false;
    el.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
    );
    await wait(500);
    return true;
  };

  const steps = {};
  steps.generalTab = await tabTo("通用");
  const light = byText("浅色");
  if (!light) return { error: "没找到「浅色」按钮", buttons: buttons().length };
  light.click();
  await wait(800);
  steps.lightPicked = true;

  steps.themesTab = await tabTo("主题");
  const card = buttons()
    .filter((b) => (b.textContent || "").includes("Carbon Fiber"))
    .pop();
  if (!card) return { error: "没找到 Carbon Fiber 卡片" };
  card.click();
  await wait(800);

  const d = getComputedStyle(document.documentElement);
  const surfaceEl = document.querySelector(
    "[data-verta-surface], .verta-surface, .verta-frame",
  );
  const ss = surfaceEl ? getComputedStyle(surfaceEl) : null;
  return {
    htmlClass: document.documentElement.className,
    shadowTheme: localStorage.getItem("verta-ui-theme-id-shadow"),
    shadowMode: localStorage.getItem("verta-ui-theme-shadow"),
    vars: {
      background: d.getPropertyValue("--background").trim(),
      frame: d.getPropertyValue("--frame").trim(),
      surfaceImage: d.getPropertyValue("--surface-image").trim().slice(0, 120),
      surfaceOpacity: d.getPropertyValue("--surface-opacity").trim(),
      surfaceBlend: d.getPropertyValue("--surface-blend").trim(),
    },
    surfaceEl: surfaceEl
      ? {
          cls: (surfaceEl.className || "").toString().slice(0, 60),
          backgroundImage: (ss.backgroundImage || "").slice(0, 140),
          opacity: ss.opacity,
          blend: ss.mixBlendMode,
        }
      : null,
  };
})();