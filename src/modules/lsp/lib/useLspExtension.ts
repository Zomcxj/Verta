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
  // Session startup and crash toasts happen outside React, so the copy is translated
  // here and handed down. It is passed via a ref instead of a dependency: switching
  // language should not tear down and rebuild an already-connected server.
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
