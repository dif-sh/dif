# typed: false
# frozen_string_literal: true

# dif.sh — experiments live in the repo.
#
# This formula is hand-maintained for v0.1.0. After cargo-dist bootstraps,
# it will be regenerated automatically on every release. See the tap repo
# README for the migration path.

class Dif < Formula
  desc "Experimentation-as-code for AI-native teams"
  homepage "https://dif.sh"
  version "0.1.1"
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
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-x86_64-unknown-linux-gnu.tar.gz"
      sha256 "REPLACE_ME_SHA256_X86_64_LINUX"
    end
    on_arm do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-aarch64-unknown-linux-gnu.tar.gz"
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
