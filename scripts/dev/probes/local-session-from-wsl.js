// Acceptance: while sitting on a WSL terminal, click a **local** session; it must open in a local terminal (fix
// R: it used to open as WSL).
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const wanted = "/vibe/coding".length ? "F:\VibeCoding_workspace\PasteLabel" : "";
  const altWanted = "PasteLabel";
  const railButton = [...document.querySelectorAll("button")].find(
    (b) => b.textContent.trim() === "会话",
  );
  railButton?.click();
  await sleep(2500);

  const cwdBefore = [...document.querySelectorAll("input, span")]
    .map((n) => n.textContent ?? n.value ?? "")
    .find((text) => /^(\/home\/|\/mnt\/|[A-Za-z]:[\/])/.test(text.trim()));
  const rows = [...document.querySelectorAll("button")].filter((b) =>
    ((b.getAttribute("title") ?? "").includes(altWanted)),
  );
  const row = rows.find((b) => (b.getAttribute("title") ?? "").includes("F:"));
  if (!row) return JSON.stringify({ error: "没找到本机 PasteLabel 会话行", found: rows.length });
  const rowTitle = row.getAttribute("title");
  row.click();
  await sleep(9000);
  return JSON.stringify(
    {
      cwdBefore: cwdBefore ?? null,
      rowTitle,
      tabStrip: document.body.innerText.split("\n").slice(0, 8),
      windowTitle: document.title,
    },
    null,
    2,
  );
})();
