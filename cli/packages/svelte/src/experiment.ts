// experiment(id, branches) — a Svelte store of the assigned branch value.
//
// Server-first (so the first client render matches SSR — no hydration flicker),
// falls back to client assignment on ISR-cached pages, and fires the exposure
// exactly once on the client when the store is first subscribed. Never fires on
// the server.

import { readable, type Readable } from "svelte/store";
import { getContext } from "svelte";
import { assign, recordExposure } from "@dif.sh/sdk";
import { DIF_CONTEXT_KEY, type DifData } from "./context.js";

export interface ExperimentValue<R> {
  /** The assigned branch's value. */
  value: R;
  /** The assigned variant id. */
  variant: string;
}

interface Decision {
  variant: string;
  bucket: number | null;
  exposed: boolean;
}

/**
 * Assign an experiment and return a Svelte store of `{ value, variant }`.
 *
 * ```svelte
 * <script lang="ts">
 *   import { experiment } from "@dif.sh/svelte";
 *   const cta = experiment("insights-cta-copy", {
 *     control:   () => "Read more",
 *     variant_a: () => "Get the full breakdown",
 *   });
 * </script>
 * <a>{$cta.value}</a>
 * ```
 *
 * Reads the server's decision from context (set by the root layout) when present
 * so SSR and the first client render agree. Must be called during component
 * initialization (it reads Svelte context).
 */
export function experiment<V extends string, R>(
  id: string,
  branches: Record<V, () => R>,
): Readable<ExperimentValue<R>> {
  const data = getContext<DifData | undefined>(DIF_CONTEXT_KEY);
  const keys = Object.keys(branches) as V[];
  const fallback = keys[0]!;

  const decided = decide(id, data, fallback);
  // Guard against drift: if the decided variant isn't one of the branches we
  // were handed, fall back to the first declared branch.
  const variant: V = (decided.variant in branches ? decided.variant : fallback) as V;
  const result: ExperimentValue<R> = { value: branches[variant](), variant };

  return readable(result, () => {
    // The start fn runs on every (re)subscribe, including SSR — only fire on the
    // client. recordExposure dedupes per (id, user), so repeats are harmless.
    if (typeof window === "undefined") return;
    if (decided.exposed && decided.bucket !== null) {
      recordExposure(id, decided.variant, decided.bucket);
    }
  });
}

function decide(id: string, data: DifData | undefined, fallback: string): Decision {
  const server = data?.assignments[id];
  if (server) {
    return { variant: server.variant, bucket: server.bucket, exposed: server.exposed };
  }
  // No server assignment (ISR-cached page, or id not registered server-side):
  // assign on the client using the cookie-stable user id.
  const userId =
    typeof document !== "undefined" ? (data?.difUid ?? readCookie("dif_uid")) : null;
  const a = assign(id, { userId, attributes: data?.attributes ?? {} });
  if (!a) return { variant: fallback, bucket: null, exposed: false };
  return { variant: a.variant, bucket: a.bucket, exposed: a.exposed };
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]!) : null;
}
