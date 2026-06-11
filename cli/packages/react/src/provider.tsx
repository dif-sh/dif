"use client";

import { createContext, useContext, useRef, useEffect, type ReactNode } from "react";
import { dif, syncOverrides, mountDifPreview } from "@dif.sh/sdk";
import type { DifInitConfig, TrackProps } from "@dif.sh/sdk";

interface ExperimentFn {
  <V extends string, R>(id: string, branches: Record<V, () => R>): () => R;
}

export interface DifContextValue {
  /** Fire a metric event. Matches the cloud-page snippet's `const { track } = useDif()`. */
  track: (metric: string, opts?: TrackProps) => void;
  /** Experiment assignment — same signature as the bare `dif(...)` function. */
  exposure: ExperimentFn;
}

const DifContext = createContext<DifContextValue | null>(null);

export interface DifProviderProps {
  config: DifInitConfig;
  children: ReactNode;
  /** Honor `?_dif=` / `_dif`-cookie QA forces. Default `true`; set `false` to gate by env. */
  allowOverrides?: boolean;
  /** Show the preview badge when a force is active. Default `true`. */
  preview?: boolean;
}

/**
 * Initializes the SDK exactly once and provides `useDif()` to descendants.
 *
 * The SDK's underlying state is a module-level singleton, so re-mounting the
 * provider with a different config will replace the previous config. v0 does
 * not re-init on prop changes — pass a stable config object.
 */
export function DifProvider({ config, children, allowOverrides, preview }: DifProviderProps) {
  const initialized = useRef(false);
  if (!initialized.current) {
    dif.init(config);
    initialized.current = true;
  }

  // Client-only (effects don't run during SSR): reconcile QA/preview forces from
  // the `?_dif=` URL param / `_dif` cookie, then show the badge if one is active.
  useEffect(() => {
    syncOverrides({ allow: allowOverrides !== false });
    if (preview !== false) mountDifPreview();
  }, [allowOverrides, preview]);

  const value: DifContextValue = {
    track: (metric, opts) => dif.track(metric, opts),
    exposure: ((id, branches) => dif(id, branches)) as ExperimentFn,
  };

  return <DifContext.Provider value={value}>{children}</DifContext.Provider>;
}

/** Hook returning `{ track, exposure }`. Must be called inside `<DifProvider>`. */
export function useDif(): DifContextValue {
  const ctx = useContext(DifContext);
  if (!ctx) {
    throw new Error("useDif must be called inside <DifProvider>");
  }
  return ctx;
}
