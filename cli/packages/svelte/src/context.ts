import type { AttributeBag } from "@dif.sh/sdk";

/** One server-decided assignment, serialized into SvelteKit load data. */
export interface SerializedAssignment {
  variant: string;
  /** Bucket `0..9999`, or `null` when the assignment fell through. */
  bucket: number | null;
  /** True when the server bucketed a real variant and the client owes an exposure. */
  exposed: boolean;
}

/**
 * What the server hands the client (via `load` data) to make the first client
 * render match SSR and avoid flicker.
 */
export interface DifData {
  /** First-party anonymous id read/minted from the `dif_uid` cookie. */
  difUid: string;
  /** id → server assignment. An absent id means the client assigns locally. */
  assignments: Record<string, SerializedAssignment>;
  /** Attributes the server resolved from request headers, reused by the client. */
  attributes: AttributeBag;
  /** Active QA/preview forces (id → variant), from `?_dif=` / the `_dif` cookie. */
  overrides: Record<string, string>;
}

/** Svelte context key under which the root layout stashes {@link DifData}. */
export const DIF_CONTEXT_KEY = Symbol("dif");
