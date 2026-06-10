# @dif.sh/cli

The dif.sh CLI, packaged for npm.

```sh
npm install -g @dif.sh/cli
dif --help
```

Under the hood, this package downloads the matching Rust binary from the
[dif-sh/dif](https://github.com/dif-sh/dif) GitHub release matching its own
version, drops it in `node_modules/@dif.sh/cli/bin/`, and exposes a thin
Node shim as the `dif` command.

If you'd rather skip the wrapper entirely, install the binary directly:

```sh
# macOS / Linux
curl -fsSL https://dif.sh/install.sh | sh

# macOS via Homebrew
brew install dif-sh/tap/dif
```

See [the main repo](https://github.com/dif-sh/dif) for full documentation.

## Platforms

- macOS (Apple Silicon + Intel)
- Linux x86_64 + aarch64
- Windows x86_64

Other platforms fall through to a clear error message pointing at the GitHub
release page where you can download a binary manually.
