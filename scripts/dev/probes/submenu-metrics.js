// 验收悬浮窗宽度：读子菜单容器的宽度与每个条目的高度（高度超过一行说明折行了）。
(async () => {
  const sub = document.querySelector("[data-slot='dropdown-menu-sub-content']");
  const rect = (node) => {
    const r = node.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  };
  if (!sub) return JSON.stringify({ submenu: null });
  return JSON.stringify(
    {
      submenu: rect(sub),
      items: [...sub.querySelectorAll("[role='menuitem']")].map((node) => ({
        text: node.textContent?.trim(),
        ...rect(node),
      })),
    },
    null,
    2,
  );
})();