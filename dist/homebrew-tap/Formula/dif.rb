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
  version "0.3.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-aarch64-apple-darwin.tar.gz"
      sha256 "d2545f74141961d6dd2ee256bb7b81237b6beb4754ce8973b36ae5d36f8fd1b3"
    end
    on_intel do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-x86_64-apple-darwin.tar.gz"
      sha256 "807c262cf868bd195019f4146ec73a45f9e63f631f3a9111aea7de6e5d4aeec2"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-x86_64-unknown-linux-gnu.tar.gz"
      sha256 "951b527f70f38acce0c360787b3a685df2d742ef3c28d38d048e7bc2b33f4ce3"
    end
    on_arm do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-aarch64-unknown-linux-gnu.tar.gz"
      sha256 "671d3dcd4b8cd7bc4eeb2152af68bae5a4f1462aa904e375b759854a6f31fbd8"
    end
  end

  def install
    bin.install "dif"
  end

  test do
    assert_match "dif", shell_output("#{bin}/dif --help")
  end
end
