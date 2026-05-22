# Homebrew tap template

This directory is a **template** for the separate `dif-sh/homebrew-tap`
repository. Copy `Formula/dif.rb` into that repo (not this one) once it
exists.

The structure of a Homebrew tap repo is exactly this: a top-level
`Formula/` directory with one `.rb` file per formula. Users install via:

```sh
brew install dif-sh/tap/dif
```

Behind the scenes, that resolves to `github.com/dif-sh/homebrew-tap` and
runs `Formula/dif.rb`.

## Keeping it in sync with releases

For now the formula's `url` and `sha256` fields are placeholders. Two ways
to keep them current:

1. **Manual**: after every `v*` tag push, copy the new tarball URL + SHA-256
   from the GitHub release page into the formula, commit + push.
2. **Automatic**: enable cargo-dist's `tap = "dif-sh/homebrew-tap"`
   integration (already configured in `cli/Cargo.toml`). cargo-dist will
   open a PR against the tap repo on every release.

Once cargo-dist is bootstrapped (`cargo dist init` in `cli/`), the
automation kicks in and this template can be deleted.
