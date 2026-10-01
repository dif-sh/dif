# typed: false
# frozen_string_literal: true

# dif.sh — experiments live in the repo.
#
# Auto-patched on every release by .github/workflows/release.yml: the `version`
# line and each `sha256` are filled from the just-built release artifacts. The
# REPLACE_ME placeholders are substituted on the release that introduces them
# and kept fresh on later releases. Do not hand-edit the version/sha lines —
# and note the formula only updates once the auto-opened PR is merged.

class Dif < Formula
  desc "Feature flags and A/B tests as Markdown files in your repo"
  homepage "https://dif.sh"
  version "0.6.2"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-aarch64-apple-darwin.tar.gz"
      sha256 "d8f2d9161ed66da437248baf1c17f06bdd46744fec3f9a9b6a4c3084bdefe45c"
    end
    on_intel do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-x86_64-apple-darwin.tar.gz"
      sha256 "c08d5f86b505b8fcfcea60a1dbd4569bb6351f9f247ddbfea6d6eb3af65f091c"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-x86_64-unknown-linux-musl.tar.gz"
      sha256 "8c0317e1e855d1638c724f6257f79bb2f73ded4ee87541d93e0f7d407d5728a5"
    end
    on_arm do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-aarch64-unknown-linux-musl.tar.gz"
      sha256 "45621c6b6441c48cfd149a1b929d4f21987ea4c11458ba8d4cf191c2fc72daf3"
    end
  end

  def install
    bin.install "dif"
  end

  test do
    assert_match "dif", shell_output("#{bin}/dif --help")
  end
end
