import { native } from "@/lib/native";
import { useEffect, useState } from "react";

/**
 * 本机已安装的字体族，给设置里的字体下拉用。
 *
 * 整个进程只问后端一次（字体列表不会在一分钟内变来变去），读不到就记成 `null`：
 * 调用方看到 `null` 该退回手输框，而不是画一个空下拉。
 */
export type InstalledFonts = {
  /** `null` = 读不到（没装 gh 之外的依赖、后端报错、或跑在浏览器里）。 */
  families: string[] | null;
  loading: boolean;
};

let pending: Promise<string[] | null> | null = null;

export function loadInstalledFonts(): Promise<string[] | null> {
  pending ??= native.fontsList().then(
    (families) => families,
    () => null,
  );
  return pending;
}

export function useInstalledFonts(): InstalledFonts {
  const [state, setState] = useState<InstalledFonts>({
    families: null,
    loading: true,
  });

  useEffect(() => {
    let alive = true;
    void loadInstalledFonts().then((families) => {
      if (alive) setState({ families, loading: false });
    });
    return () => {
      alive = false;
    };
  }, []);

  return state;
}
