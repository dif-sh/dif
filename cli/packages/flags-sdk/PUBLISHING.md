# Publishing `@dif.sh/flags-sdk`

The [Flags SDK](https://flags-sdk.dev/) adapter for dif, published from this
repo alongside the other `@dif.sh/*` packages.

## Why not `@flags-sdk/dif`

Vercel publishes the `@flags-sdk/*` adapters themselves. Their own
`providers/custom-adapters` page frames outside integrations as adapters you
write and publish yourself: "We publish adapters for the most common providers,
but it is also possible to write a custom adapter in case we don't list your
provider." So this ships under the `@dif.sh` scope, and the ask to Vercel is a
listing, not a merge.

## Release

Versioned in lockstep with `@dif.sh/{cli,sdk,react,svelte,openfeature}`.
`scripts/check-versions.mjs` asserts the version and the `@dif.sh/sdk` peer
range; the `npm-publish` job in `.github/workflows/release.yml` stamps the tag
version and publishes.

`@dif.sh/sdk` must stay a **peer** dependency. The experiment registry is a
module-level `Map` inside the SDK, so a nested second copy under
`node_modules/@dif.sh/flags-sdk/` would be empty and every flag would throw and
fall back to its `defaultValue`.

Locally:

```sh
npm install && npm run lint && npm test && npm run build
```

Tests run on `vitest` 3, deliberately. Vitest 4 bundles with `rolldown`, whose
platform-native binary npm drops from a lockfile generated on another OS
(npm/cli#4828), so CI died at vitest startup with "Cannot find native binding".
Vitest 3 is rollup-based and records every platform's optional binding in the
lockfile. Pinning it also removed the npm 10 resolver crash on the vitest 4 →
vite 8 peer chain, so the `legacy-peer-deps` `.npmrc` is gone.

## Asking Vercel for a listing

The providers page on flags-sdk.dev is generated from the vercel/flags repo:
`apps/docs/content/docs/providers/meta.json` (community adapters sit in the
`---Others---` group) plus an entry in
`apps/docs/components/custom/provider-list.tsx` and a logo component under
`apps/docs/components/custom/logos/`.

- Open an issue or discussion on vercel/flags asking whether they would list a
  community adapter. Link the npm package, the docs page, and the example repo
  (github.com/dif-sh/nextjs-feature-flags). Don't open a PR that adds the
  package itself.
- `docs/dif.mdx` here is a draft written in their docs' MDX conventions. It is
  also the source for dif's own page — publish it under
  `https://www.dif.sh/docs/` and link it from `/docs/sdk/`, which stays the
  canonical reference either way.

## If Vercel's policy changes

To upstream it as `packages/adapter-dif` (`@flags-sdk/dif`):

1. Fork vercel/flags, `corepack enable`, `pnpm install`, branch.
2. Copy `src/`, `package.json`, `tsup.config.js`, `vitest.config.ts`,
   `README.md`. Leave `dist/`, `package-lock.json`, and this file.
3. `package.json`: name `@flags-sdk/dif`, `version` `0.0.0`, drop `engines` and
   `prepublishOnly`, `homepage` `https://flags-sdk.dev`, `bugs`/`repository`
   back to vercel/flags, `devDependencies.flags` → `workspace:*`,
   `@dif.sh/sdk` → `^0.6.1` (keep the peer), add `"check": "biome check"`, and
   match the pins in `packages/adapter-reflag` (`vite` 8.1.5, `typescript`
   `^5.9.3`, `vitest` 4.1.10, `@types/node` 22.14.0, `rimraf` 6.1.2, `tsup`
   8.5.1). Upstream runs pnpm, which installs rolldown's native binding
   correctly, so their vitest 4 pin is fine there.
4. `tsconfig.json` → `{ "extends": "../../tsconfig-base.json", "include": ["src"] }`.
5. Flip `PACKAGE` in `src/index.ts` back to `@flags-sdk/dif`.
6. Docs: `docs/dif.mdx` → `apps/docs/content/docs/providers/dif.mdx`, add
   `"dif"` to `meta.json` under `---Adapters---`, add
   `apps/docs/components/custom/logos/dif.tsx` (wordmark paths with
   `fill="currentColor"`, the lime slash at `#D8FF86`), and register it in
   `provider-list.tsx` with `badges: ['Adapter', 'Flags Explorer']`,
   `glowColor: '#D8FF86'`, `skipInvert: true`.
7. Add dif to `skills/flags-sdk/references/providers.md` and the provider list
   in that skill's `description`.
8. `pnpm changeset` (minor), then `pnpm format && pnpm -F @flags-sdk/dif
   type-check && pnpm -F @flags-sdk/dif test && pnpm -F @flags-sdk/dif build &&
   pnpm validate-packages && pnpm publint && pnpm attw && pnpm validate-skills`.
