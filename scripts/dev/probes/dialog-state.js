// Current popover / dialog state: used to tell whether a shortcut fired at all (Ctrl+P opening the command
// palette, say).
(() => {
  const dialogs = [...document.querySelectorAll('[role="dialog"], [role="menu"]')].map(
    (el) => ({
      role: el.getAttribute("role"),
      title: (el.getAttribute("aria-label") || "").slice(0, 30),
      text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 50),
    }),
  );
  const inputs = [...document.querySelectorAll("input, textarea")].map((el) => ({
    placeholder: el.getAttribute("placeholder") || "",
    focused: el === document.activeElement,
  }));
  return {
    dialogCount: dialogs.length,
    dialogs,
    inputCount: inputs.length,
    focusedInput: inputs.find((i) => i.focused) ?? null,
  };
})();