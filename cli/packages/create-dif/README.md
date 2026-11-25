# create-dif

Add [dif.sh](https://www.dif.sh) to an existing app. Run it in your app's folder, next to `package.json`:

```bash
npm create dif@latest
```

Or `pnpm create dif`, `yarn create dif`, or `bun create dif`.

It installs `@dif.sh/cli` as a dev dependency with your package manager, then runs `dif init`. `dif init` asks what
you want to use, writes the `dif/` workspace, and installs the SDK package for your framework.

Arguments after `--` go to `dif init`:

```bash
npm create dif@latest -- --yes --framework react
```

Docs: https://www.dif.sh/docs/
