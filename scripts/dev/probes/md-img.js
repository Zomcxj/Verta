(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(500);
  const imgs = [...document.querySelectorAll("img")];
  const out = [`<img> 共 ${imgs.length} 个`];
  for (const img of imgs.slice(0, 4)) {
    out.push(`  src=${img.getAttribute("src")?.slice(0, 90)}`);
    out.push(`     natural=${img.naturalWidth}x${img.naturalHeight} complete=${img.complete}`);
  }
  const broken = [...document.querySelectorAll("span")].filter((s) =>
    (s.textContent ?? "").includes("not found"),
  );
  out.push(`"not found" 标记: ${broken.length} 个`);
  if (broken[0]) out.push(`   title=${broken[0].getAttribute("title")}`);
  return out.join("\n");
})();
