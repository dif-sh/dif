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
  version "0.2.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-aarch64-apple-darwin.tar.gz"
      sha256 "a3e9904bf61187e3f3b27066feb47f7a2642e83a2a0ec0abb70001118470bbde"
    end
    on_intel do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-x86_64-apple-darwin.tar.gz"
      sha256 "2fb1618320f73a680b621bdcf93529e565ae84a1ed4a7366f387599869865233"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-x86_64-unknown-linux-gnu.tar.gz"
      sha256 "3d29972a295b10e626a4851a40ce90c6eed923fbe2ab64cfd91ae0496e5de9c7"
    end
    on_arm do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-aarch64-unknown-linux-gnu.tar.gz"
      sha256 "8bdc5e9b1c555336935ff4aa76ee1832d740edf99365e99a2f30a216725c9e17"
    end
  end

  def install
    bin.install "dif"
  end

  test do
    assert_match "dif", shell_output("#{bin}/dif --help")
  end
end
