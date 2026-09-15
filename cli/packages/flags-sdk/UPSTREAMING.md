# Upstreaming `@flags-sdk/dif` into vercel/flags

This directory is staged to become `packages/adapter-dif` in
[github.com/vercel/flags](https://github.com/vercel/flags). It is marked
`"private": true` so nobody publishes under Vercel's `@flags-sdk` scope from
this repo.

## 0. Before you start

- `@dif.sh/sdk` must be published at `^0.6.1` on npm **at least 2 days before**
  you open the PR. vercel/flags sets `minimumReleaseAge: 2880` (minutes) in
  `pnpm-workspace.yaml`, and `@dif.sh/*` is not in its exclude list, so
  `pnpm install` refuses a younger release.
- In this repo, confirm the package is green:
  `cd cli/packages/flags-sdk && npm install && npx tsc --noEmit && npm test && npm run build`.

## 1. Fork and clone

```sh
gh repo fork vercel/flags --clone
cd flags
nvm use            # .nvmrc
corepack enable    # pnpm version from packageManager
pnpm install
git checkout -b adapter-dif
```

## 2. Copy the package

```sh
DIF=/path/to/dif/cli/packages/flags-sdk
mkdir -p packages/adapter-dif
cp -R "$DIF"/{src,package.json,tsup.config.js,tsconfig.json,vitest.config.ts,README.md} packages/adapter-dif/
cp "$DIF"/docs/dif.mdx apps/docs/content/docs/providers/dif.mdx
```

Do not copy `node_modules/`, `dist/`, `package-lock.json`, `.npmrc`, `docs/`,
or this file. (`.npmrc` works around an npm 10 peer-resolution crash; pnpm
does not need it.)

## 3. Edit `packages/adapter-dif/package.json`

1. Delete `"private": true`.
2. Set `"version": "0.0.0"`. The changeset in step 7 bumps it to `0.1.0`.
   Leave `CHANGELOG.md` out; changesets creates it on release.
3. `devDependencies.flags`: `"^4.3.1"` → `"workspace:*"`.
4. `devDependencies["@dif.sh/sdk"]`: `"file:../sdk"` → `"^0.6.1"`.
   Keep `peerDependencies["@dif.sh/sdk"]` at `"^0.6.1"`. It must stay a peer:
   the experiment registry is a module-level `Map`, so a nested copy under
   `node_modules/@flags-sdk/dif/node_modules` would be empty and every flag
   would throw.
5. Add `"check": "biome check"` to `scripts`, matching `adapter-reflag`.
6. Match the pinned versions of `@types/node`, `rimraf`, `tsup`, `typescript`,
   and `vitest` to `packages/adapter-reflag/package.json` on `main`, and add
   its `vite` pin (left out here because of the npm crash noted above).
7. Set `"author"` to whoever will maintain the adapter.

## 4. Replace `packages/adapter-dif/tsconfig.json`

```json
{
  "extends": "../../tsconfig-base.json",
  "include": ["src"]
}
```

## 5. Format, lint, test, build

```sh
pnpm install
pnpm biome check --write packages/adapter-dif apps/docs/content/docs/providers/dif.mdx
pnpm -F @flags-sdk/dif type-check
pnpm -F @flags-sdk/dif test
pnpm -F @flags-sdk/dif build
pnpm validate-packages
pnpm publint
```

`src/index.test.ts` runs a real `flag()` from `flags/next`, so a breaking
change in `workspace:*` `flags` shows up here.

## 6. Docs

1. `apps/docs/content/docs/providers/dif.mdx` is in place from step 2.
2. Add `"dif"` to `apps/docs/content/docs/providers/meta.json` under
   `"---Adapters---"`, after `"flagsmith"`.
3. Add `apps/docs/components/custom/logos/dif.tsx`, shaped like
   `logos/reflag.tsx`:

   ```tsx
   export function DifLogo(props: React.SVGProps<SVGSVGElement>) {
     return (
       <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 W H" fill="none" {...props}>
         {/* dif.sh wordmark paths, single fill so the list can invert it */}
       </svg>
     );
   }
   ```

4. Register it in `apps/docs/components/custom/provider-list.tsx`: import
   `DifLogo` from `./logos/dif` and add to `providers`:

   ```ts
   {
     key: 'dif',
     name: 'dif.sh',
     href: '/providers/dif',
     logo: DifLogo,
     badges: ['Adapter', 'Flags Explorer'],
   },
   ```

5. `pnpm dev:docs` and check `/providers/dif` and the provider list render.

## 7. Changeset

```sh
pnpm changeset
```

Select `@flags-sdk/dif`, choose `minor`, and use:

> Introduce the dif.sh adapter. `difAdapter.variant()` and `difAdapter.isEnabled()` assign from `dif/generated/client.ts`; `getProviderData()` emits registered experiments for the Flags Explorer.

## 8. Open the PR

```sh
git add packages/adapter-dif apps/docs .changeset pnpm-lock.yaml
git commit -m "feat: add dif.sh adapter (@flags-sdk/dif)"
git push -u origin adapter-dif
gh pr create --repo vercel/flags --title "feat: add dif.sh adapter (@flags-sdk/dif)"
```

PR body should cover: what dif.sh is (flags and experiments as `.md` files,
`dif build` generates a typed client), that assignment is local with no
network call, why `@dif.sh/sdk` is a peer dependency, that `onExposure` is not
fired for forced or unbucketed requests, and the test command. Offer to add a
`flags-sdk/dif` template to vercel/examples if the maintainers want one.

## If Vercel declines

Publish from this repo under the dif.sh scope instead:

1. In `package.json`: `"name": "@dif.sh/flags-sdk"`, delete `"private": true`,
   set `repository` to `git+https://github.com/dif-sh/dif.git` with
   `"directory": "cli/packages/flags-sdk"`, `homepage` to
   `https://www.dif.sh/docs/`, and `bugs.url` to
   `https://github.com/dif-sh/dif/issues`.
2. In `src/index.ts`: change `const PACKAGE = '@flags-sdk/dif'` to
   `'@dif.sh/flags-sdk'` (it prefixes error messages and the `adapterId`
   symbol) and update the JSDoc import paths.
3. Replace `@flags-sdk/dif` with `@dif.sh/flags-sdk` in `README.md` and
   `docs/dif.mdx`, and point the doc links at a page on
   `https://www.dif.sh/docs/` instead of `flags-sdk.dev`.
4. Add a `"prepublishOnly": "npm run type-check && npm test && npm run build"`
   script and bump `@dif.sh/sdk` in `peerDependencies` whenever the SDK's
   minor version changes.
5. Release it with the other `@dif.sh/*` packages:
   `cd cli/packages/flags-sdk && npm publish --access public`.
6. Ask Vercel to list it under "Others" in `providers/meta.json` as a
   community adapter.
