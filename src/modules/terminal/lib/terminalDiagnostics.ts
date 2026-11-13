import { BoundedResourceTrace } from "@/modules/terminal/lib/BoundedResourceTrace";
import { subscribeWindowPresentation } from "@/modules/terminal/ghostty/windowPresentation";
import { invoke } from "@tauri-apps/api/core";
import { supportsWasmSimd } from "@verta/ghostty-core/adapted";
import { ghosttyCoreRuntimeDiagnostics } from "@/modules/terminal/ghostty/GhosttyCoreRuntime";
import { webGpuTerminalRuntimeDiagnostics } from "@/modules/terminal/ghostty/gpu/WebGpuTerminalRuntime";
import { webGlTerminalRuntimeDiagnostics } from "@/modules/terminal/ghostty/webgl/WebGlTerminalRuntime";
import {
  ghosttySessionDiagnostics,
  ghosttySessionResourceTotals,
} from "@/modules/terminal/ghostty/useGhosttyTerminalSession";
import { ptyTransportDiagnostics } from "@/modules/terminal/lib/pty-bridge";
import { terminalResizeInteractionActive } from "@/modules/terminal/lib/terminalResizeInteraction";
import { windowPresentationDiagnostics } from "@/modules/terminal/ghostty/windowPresentation";

export function terminalDebugStats() {
  return {
    schemaVersion: 1,
    timestamp: Date.now(),
    presentation: windowPresentationDiagnostics(),
    wasmVariant: supportsWasmSimd() ? "simd" : "scalar",
    ptyTransport: ptyTransportDiagnostics(),
    ghosttyCore: ghosttyCoreRuntimeDiagnostics(),
    ghosttyWebGpu: webGpuTerminalRuntimeDiagnostics(),
    ghosttyWebGl: webGlTerminalRuntimeDiagnostics(),
    ghosttySessions: ghosttySessionDiagnostics(),
    ghosttyResources: ghosttySessionResourceTotals(),
    terminalResizeInteractionActive: terminalResizeInteractionActive(),
    domCanvases: document.querySelectorAll("canvas").length,
    jsHeapBytes:
      (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
        ?.usedJSHeapSize ?? null,
  };
}

export async function terminalDebugSnapshot() {
  const native = await invoke("pty_diagnostics");
  return { ...terminalDebugStats(), native };
}

/**
 * Install the diagnostics globals.
 *
 * `extra` is the application's own: this module belongs to the terminal, and the things it knows
 * about are terminals. What is app-level (the session-opening cover, for one) is supplied by the
 * entry point, which is where the two are allowed to meet - so a terminal module never has to
 * import the application to report on it.
 */
export function installTerminalDiagnostics(
  extra: () => Record<string, unknown> = () => ({}),
): void {
  Object.assign(window, {
    __vertaTerm: () => ({ ...terminalDebugStats(), ...extra() }),
    __vertaTermSnapshot: async () => {
      const [stats, native] = await Promise.all([
        terminalDebugSnapshot(),
        Promise.resolve(extra()),
      ]);
      return { ...stats, ...native };
    },
    __vertaTermTrace: recordTerminalResources,
  });
}

let activeTrace: { stop: () => unknown } | null = null;

export function recordTerminalResources() {
  activeTrace?.stop();
  const trace = new BoundedResourceTrace<ReturnType<typeof resourceSample>>();
  const capture = () => trace.record(resourceSample());
  const unsubscribe = subscribeWindowPresentation(capture);
  const timer = setInterval(capture, 1_000);
  const deadline = setTimeout(() => recording.stop(), 10 * 60_000);
  let stopped = false;
  const recording = {
    snapshot: () => trace.snapshot(),
    stop: () => {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
        clearTimeout(deadline);
        capture();
        unsubscribe();
        if (activeTrace === recording) activeTrace = null;
      }
      return trace.snapshot();
    },
  };
  activeTrace = recording;
  return recording;
}

function resourceSample() {
  const gpu = webGpuTerminalRuntimeDiagnostics();
  const gl = webGlTerminalRuntimeDiagnostics();
  return {
    timestamp: Date.now(),
    presentation: windowPresentationDiagnostics(),
    core: ghosttyCoreRuntimeDiagnostics(),
    surfaces: ghosttySessionResourceTotals(),
    webgpu: gpu && {
      canvases: gpu.canvases,
      atlasCount: gpu.atlasCount,
      atlasBytes: gpu.atlasBytes,
      atlasCpuBytes: gpu.atlasCpuBytes,
      stagingBytes: gpu.stagingBytes,
      inFlightFrames: gpu.inFlightFrames,
      submittedFrames: gpu.submittedFrames,
      deviceRecoveries: gpu.deviceRecoveries,
    },
    webgl: gl,
  };
}

if (import.meta.hot) import.meta.hot.dispose(() => activeTrace?.stop());
