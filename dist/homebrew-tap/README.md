# Homebrew formula (source for dif-sh/homebrew-tap)

`Formula/dif.rb` in this directory is the source of truth for the public tap
at [dif-sh/homebrew-tap](https://github.com/dif-sh/homebrew-tap). Users
install with:

```sh
brew install dif-sh/tap/dif
```

That resolves to `github.com/dif-sh/homebrew-tap` and runs `Formula/dif.rb`
there, which downloads the matching release tarball from
`github.com/dif-sh/dif/releases` (macOS arm64 and x86_64, Linux arm64 and
x86_64 musl).

## On each release

1. Pushing a `v*` tag runs `.github/workflows/release.yml`. Its
   `homebrew-formula` job rewrites the `version` line and the four `sha256`
   lines in `dist/homebrew-tap/Formula/dif.rb` from the release artifacts,
   then opens a PR against `main` titled
   `chore: homebrew formula sha256s for vX.Y.Z`.
2. Merge that PR.
3. Copy the merged `Formula/dif.rb` into `dif-sh/homebrew-tap` and push. No
   job does this yet, so until it happens `brew install` keeps serving the
   previous version.
4. Check it: `brew update && brew upgrade dif && dif --version`.

The tap repo's own `README.md` holds the user-facing install instructions;
this file isn't copied there.
