/**
 * 设置里字体下拉的选项。
 *
 * 「自动检测」是一个真实选项（值是空串），因为终端/图标的空值在老行为里就是自动检测。
 * 另外把**当前值**也塞进选项：配置可能是在别的机器上写的、或者字体后来被卸了，
 * 选项里没有它就显示不出当前状态（Select 会显示空白）。
 */

export type FontOption = {
  /** Select 的 value：字体族名；空串表示「自动检测」。 */
  value: string;
  label: string;
  /** 本机没装：界面上标一句，别让人以为是这个字体出了毛病。 */
  missing?: boolean;
};

export function fontOptions(
  installed: string[] | null,
  current: string,
  autoLabel: string,
): FontOption[] {
  const options: FontOption[] = [{ value: "", label: autoLabel }];
  const seen = new Set<string>([""]);
  const key = (value: string) => value.trim().toLowerCase();

  const currentName = current.trim();
  if (currentName && !(installed ?? []).some((name) => key(name) === key(currentName))) {
    options.push({ value: currentName, label: currentName, missing: true });
    seen.add(key(currentName));
  }

  for (const raw of installed ?? []) {
    const name = raw.trim();
    if (!name || seen.has(key(name))) continue;
    seen.add(key(name));
    options.push({ value: name, label: name });
  }
  return options;
}
