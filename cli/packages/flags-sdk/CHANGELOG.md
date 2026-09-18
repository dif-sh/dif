# @flags-sdk/dif

## 0.1.0

### Minor Changes

- Introduce the dif.sh adapter. `difAdapter.variant()` returns the variant `assign()` picks from `dif/generated/client.ts`, `difAdapter.isEnabled()` returns `true` off the first declared variant, `identify` reads the `dif_uid` cookie, the `_dif` cookie forces a variant for QA, and `getProviderData()` lists every registered experiment for the Flags Explorer.
