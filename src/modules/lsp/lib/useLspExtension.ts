import { useT } from "@/modules/i18n";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { Extension } from "@codemirror/state";
import { useEffect, useRef, useState } from "react";
import { serverForLanguage } from "./presets";
import { useLspRuntimeStore } from "./runtimeStore";
import {
  acquireDocExtension,
  type LspDocHandle,
  type LspSessionLabels,
} from "./sessionManager";

export function useLspExtension(
  path: string,
  langId: string | null,
  ready: boolean,
): Extension | null {
  const [ext, setExt] = useState<Extension | null>(null);
  const t = useT();
  // 会话建立和崩溃 toast 都在 React 之外发生，所以文案在这里翻好带下去。用 ref 递
  // 而不是进依赖：换语言不该把已经连上的服务器拆掉重建一次。
  const labels: LspSessionLabels = {
    panels: {
      definitions: t("lsp.definitions"),
      references: t("lsp.references"),
    },
    toasts: {
      failedToStart: (name) => t("lsp.toast.failedToStart", { name }),
      stopped: (name) => t("lsp.stoppedNamed", { name }),
      keepsCrashing: (name) => t("lsp.toast.keepsCrashing", { name }),
      exited: (name) => t("lsp.toast.exited", { name }),
      keptCrashing: t("lsp.keptCrashing"),
      givingUp: t("lsp.givingUp"),
    },
  };
  const labelsRef = useRef(labels);
  labelsRef.current = labels;
  const customServers = usePreferencesStore((s) => s.lspCustomServers);
  const lspActivation = usePreferencesStore((s) => s.lspActivation);
  const preset = serverForLanguage(langId, customServers, lspActivation);
  const activation = preset ? lspActivation[preset.id] : undefined;
  const generation = useLspRuntimeStore((s) =>
    preset ? (s.generations[preset.id] ?? 0) : 0,
  );

  const presetId = preset?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies(generation): re-acquire after a server crash tears the session down
  // biome-ignore lint/correctness/useExhaustiveDependencies(presetId): swapping the enabled server for a language must rebind the doc
  useEffect(() => {
    if (!ready || !langId || activation !== "enabled") {
      setExt(null);
      return;
    }
    let cancelled = false;
    let handle: LspDocHandle | null = null;
    acquireDocExtension(path, langId, labelsRef.current)
      .then((h) => {
        if (!h) return;
        if (cancelled) {
          h.release();
          return;
        }
        handle = h;
        setExt(h.extension);
      })
      .catch((e) => console.error("[lsp] acquire failed", e));
    return () => {
      cancelled = true;
      handle?.release();
      setExt(null);
    };
  }, [path, langId, ready, activation, generation, presetId]);

  return ext;
}
