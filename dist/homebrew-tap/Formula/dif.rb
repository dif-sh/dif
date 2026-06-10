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
  desc "Experimentation-as-code for AI-native teams"
  homepage "https://dif.sh"
  version "REPLACE_ME_VERSION"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-aarch64-apple-darwin.tar.gz"
      sha256 "REPLACE_ME_SHA256_AARCH64_DARWIN"
    end
    on_intel do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-x86_64-apple-darwin.tar.gz"
      sha256 "REPLACE_ME_SHA256_X86_64_DARWIN"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-x86_64-unknown-linux-musl.tar.gz"
      sha256 "REPLACE_ME_SHA256_X86_64_LINUX"
    end
    on_arm do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-aarch64-unknown-linux-musl.tar.gz"
      sha256 "REPLACE_ME_SHA256_AARCH64_LINUX"
    end
  end

  def install
    bin.install "dif"
  end

  test do
    assert_match "dif", shell_output("#{bin}/dif --help")
  end
end
