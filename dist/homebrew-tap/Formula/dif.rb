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
  version "0.6.3"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-aarch64-apple-darwin.tar.gz"
      sha256 "8388886b966bb6f34392f4eae00d4958dc5c5c19bbb6598605e89f6db2227af2"
    end
    on_intel do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-x86_64-apple-darwin.tar.gz"
      sha256 "2420b2fd875b0b56e256006ba2a2c6687bd6715b3537cfbf643cb9fe05b0f010"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-x86_64-unknown-linux-musl.tar.gz"
      sha256 "2da4721676b6d284187c78811f9fef00530d3cc97895ebd57d061bd458a9cab3"
    end
    on_arm do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-aarch64-unknown-linux-musl.tar.gz"
      sha256 "48538134d98921b79b6031b6f53448c31edf73a197d3dd61bbfa38d6f58e818a"
    end
  end

  def install
    bin.install "dif"
  end

  test do
    assert_match "dif", shell_output("#{bin}/dif --help")
  end
end
