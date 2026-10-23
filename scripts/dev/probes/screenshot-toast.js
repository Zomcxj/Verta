// Region-screenshot acceptance (3/3): report the content of the follow-up toast in the **main window**, and the
// coordinates of its "insert path" button.
(() => {
  const toasts = [...document.querySelectorAll("[data-sonner-toast]")];
  const action = toasts
    .map((t) => t.querySelector("button"))
    .find((b) => b && b.innerText.trim().length > 0);
  const rect = action?.getBoundingClientRect();
  return {
    count: toasts.length,
    texts: toasts.map((t) => (t.innerText || "").replace(/\n/g, " | ")),
    action: action
      ? {
          label: action.innerText.trim(),
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        }
      : null,
  };
})();