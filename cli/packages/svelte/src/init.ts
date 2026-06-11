// Client-only SDK init for @dif.sh/svelte. Call once in the root +layout.svelte.

import { dif, syncOverrides, mountDifPreview } from "@dif.sh/sdk";
import type { DifInitConfig } from "@dif.sh/sdk";
import type { DifData } from "./context.js";

export interface InitDifOptions extends Omit<DifInitConfig, "userId" | "attributes"> {
  /** The `DifData` returned by `difLoad` (gives the stable `difUid` + server attributes). */
  data?: DifData;
  /** Cookie name. Default `"dif_uid"`. */
  cookieName?: string;
  /** Honor `?_dif=` / `_dif`-cookie QA forces. Default `true`. */
  allowOverrides?: boolean;
  /** Show the preview badge when a force is active. Default `true`. */
  preview?: boolean;
}

/**
 * Initialize the SDK on the client. `userId` resolves to the `dif_uid` cookie so
 * the client buckets identically to the server, and `attributes` reuse the
 * server's header-derived bag so audience predicates can't diverge across the
 * hydration boundary.
 *
 * ```svelte
 * <script lang="ts">
 *   import { initDif, DIF_CONTEXT_KEY } from "@dif.sh/svelte";
 *   import { setContext } from "svelte";
 *   let { data, children } = $props();
 *   setContext(DIF_CONTEXT_KEY, data.dif);
 *   initDif({ data: data.dif, publishableKey: PUBLIC_DIF_PUBLISHABLE_KEY });
 * </script>
 * ```
 */
export function initDif(opts: InitDifOptions): void {
  const { data, cookieName = "dif_uid", allowOverrides, preview, ...rest } = opts;
  const seeded = data?.difUid ?? null;
  const attrs = data?.attributes ?? {};
  dif.init({
    ...rest,
    userId: () => seeded ?? readCookie(cookieName),
    attributes: () => ({ ...attrs }),
    overrides: data?.overrides ?? {},
  } as DifInitConfig);

  // Client only: reconcile QA/preview forces from `?_dif=` / the `_dif` cookie
  // (covers the client-only model where difLoad didn't run), then show the
  // preview badge if any force is active. Both are no-ops on the server.
  if (typeof window !== "undefined") {
    syncOverrides({ allow: allowOverrides !== false });
    if (preview !== false) mountDifPreview();
  }
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]!) : null;
}
