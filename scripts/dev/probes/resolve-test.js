(async () => {
  // Verify the parsing function's input assumption directly: has the src streamdown passes in already lost its "./"
  const spans = [...document.querySelectorAll("span")].filter((s) =>
    (s.textContent ?? "").includes("not found"),
  );
  return spans.map((s) => `title=${s.getAttribute("title")}`).join("\n");
})();
