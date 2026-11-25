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
  version "0.10.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-aarch64-apple-darwin.tar.gz"
      sha256 "d73c06696cddfbb2e62cb5e68dfab0644bbc12dd09e0ccc76da5d2b2725dd1cd"
    end
    on_intel do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-x86_64-apple-darwin.tar.gz"
      sha256 "317176d2ee8f260e05c7919adfef4f18e76ec584a15bbbbf6b359665d8a542e1"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-x86_64-unknown-linux-musl.tar.gz"
      sha256 "4a45e8310ad7e8af7ac2402c79525a2bb0e83aca26b7d6e2f378dcf5659a3ac1"
    end
    on_arm do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-aarch64-unknown-linux-musl.tar.gz"
      sha256 "932657998ecb8c154e73fafd6905ffe18ecac4e8c0ab05c86e38e15154311dba"
    end
  end

  def install
    bin.install "dif"
  end

  test do
    assert_match "dif", shell_output("#{bin}/dif --help")
  end
end
