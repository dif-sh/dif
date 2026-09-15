# Listing dif.sh on openfeature.dev

How to add `@dif.sh/openfeature` to the provider catalog at
<https://openfeature.dev/ecosystem>. The catalog lives in
[`open-feature/openfeature.dev`](https://github.com/open-feature/openfeature.dev);
a provider entry is three files, the same shape as Pendo's PR
([#1454](https://github.com/open-feature/openfeature.dev/pull/1454):
`src/datasets/providers/pendo.ts`, `static/img/pendo-no-fill.svg`, and a 3-line
change to `src/datasets/providers/index.ts`).

**Publish `@dif.sh/openfeature` to npm first.** The catalog links straight to
the package, and reviewers check that the link resolves.

## 1. `src/datasets/providers/dif.ts`

Modelled on `src/datasets/providers/featurevisor.ts`. One entry: a JavaScript
server provider. The catalog builds the card title from these fields
("dif.sh JavaScript Node.js Provider") and, with no `description`, uses "The
official dif.sh provider for OpenFeature".

```ts
import DifSvg from '@site/static/img/dif-no-fill.svg';

import type { Provider } from '.';

export const Dif: Provider = {
  name: 'dif.sh',
  logo: DifSvg,
  technologies: [
    {
      technology: 'JavaScript',
      vendorOfficial: true,
      href: 'https://www.npmjs.com/package/@dif.sh/openfeature',
      category: ['Server'],
    },
  ],
};
```

To send readers to the dif docs instead of npm, set
`href: 'https://www.dif.sh/docs/sdk/'`. Other entries in the catalog link to
either.

## 2. `static/img/dif-no-fill.svg`

The `*-no-fill.svg` logos carry no `fill` attributes so the site's theme colours
them (compare `static/img/pendo-no-fill.svg`). This is
`site/static/logos/dif-short.svg` from the dif.sh site repo with the two fills
(`#143E3A`, `#D8FF86`), the root `fill="none"`, and the fixed `width`/`height`
removed:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 146 128">
  <path d="M68.4143 20V50.6678L69.8262 72.0943H68.5475C67.3886 52.8329 55.5067 42.0602 35.6857 42.0602C12.7877 42.0602 0 54.4699 0 76.5301C0 98.5903 13.8134 111 38.3631 111C57.4115 111 68.4143 100.346 68.8006 83.7515H69.8262L80.0564 108.703L111 33.1886V20H68.4143ZM54.6009 85.5205C46.6751 85.5205 42.9721 82.2333 42.9721 76.5301C42.9721 70.8269 46.6751 67.4077 54.6009 67.4077C62.5266 67.4077 67.0023 70.6949 67.0023 76.5301C67.0023 82.3653 62.1536 85.5205 54.6009 85.5205Z"/>
  <path d="M146 0L94.2587 128H84L135.741 0H146Z"/>
</svg>
```

## 3. Register it in `src/datasets/providers/index.ts`

Add the import next to the other `./<vendor>` imports:

```ts
import { Dif } from './dif';
```

and add `Dif` to the `PROVIDERS` array, after `DevCycle`:

```ts
export const PROVIDERS: Provider[] = [
  // …
  DevCycle,
  Dif,
  EnvVar,
  // …
];
```

## PR steps

The flow below follows the repo's `CONTRIBUTING.md`. It requires a DCO
sign-off on every commit, and the site uses yarn with Node `>24`.

1. Confirm `npm view @dif.sh/openfeature version` returns a published version.
2. Fork `open-feature/openfeature.dev` and clone your fork:
   ```sh
   gh repo fork open-feature/openfeature.dev --clone
   cd openfeature.dev
   git checkout -b feat/add-dif-provider
   ```
3. Add `src/datasets/providers/dif.ts` and `static/img/dif-no-fill.svg`, and
   edit `src/datasets/providers/index.ts`, as in sections 1–3.
4. Check it locally:
   ```sh
   yarn install
   yarn typecheck
   yarn lint
   yarn start   # open /ecosystem, filter Provider → Server → JavaScript
   ```
   Check the card in both light and dark theme; the logo should follow the
   text colour.
5. Commit with a sign-off and push:
   ```sh
   git add src/datasets/providers/dif.ts src/datasets/providers/index.ts static/img/dif-no-fill.svg
   git commit --signoff -m "feat: add dif.sh provider"
   git push -u origin feat/add-dif-provider
   ```
6. Open the PR against `open-feature/openfeature.dev` `main` with the title
   `feat: add dif.sh provider`. Suggested body, in the same Summary/Sources
   format as #1454:
   ```md
   ## Summary

   - Add dif.sh's official JavaScript server provider to the provider catalog.
   - Add a theme-controlled dif logo (`static/img/dif-no-fill.svg`).

   dif.sh keeps feature flags and A/B experiments as `.md` files in the repo;
   `dif build` generates a typed client, and `@dif.sh/openfeature` resolves
   OpenFeature evaluations against it (string → variant id, boolean → first
   declared variant is `false`).

   ## Sources

   - [npm package](https://www.npmjs.com/package/@dif.sh/openfeature)
   - [Source](https://github.com/dif-sh/dif/tree/main/cli/packages/openfeature)
   - [dif SDK docs](https://www.dif.sh/docs/sdk/)
   ```
7. Make sure the DCO and Netlify preview checks pass, then wait for review.
