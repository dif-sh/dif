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
  version "0.3.2"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-aarch64-apple-darwin.tar.gz"
      sha256 "9870e694cd779f2cfb17f52fa8f53f54d6e3eb9fb1d1ae87f9079277d263848a"
    end
    on_intel do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-x86_64-apple-darwin.tar.gz"
      sha256 "ba06eb4ec1e1b369f735d0384487d6416bab68b7b751a72d44cbe06029fff250"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-x86_64-unknown-linux-gnu.tar.gz"
      sha256 "f10c10d20df14616613f88e6b88414b1741da71082caf36c74bd79832070c932"
    end
    on_arm do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-aarch64-unknown-linux-gnu.tar.gz"
      sha256 "6e16c6186f198a1b5a0ddd00c4738a014fbe5532669900e785679e1effbd967c"
    end
  end

  def install
    bin.install "dif"
  end

  test do
    assert_match "dif", shell_output("#{bin}/dif --help")
  end
end
