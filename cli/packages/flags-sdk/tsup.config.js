import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  splitting: true,
  sourcemap: true,
  minify: false,
  clean: false,
  skipNodeModulesBundle: true,
  dts: true,
  // `@dif.sh/sdk` must never be bundled: its experiment registry is a
  // module-level Map, so an inlined copy would be empty.
  external: ['node_modules', '@dif.sh/sdk'],
});
