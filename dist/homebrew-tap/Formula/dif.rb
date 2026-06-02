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
  version "0.4.1"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-aarch64-apple-darwin.tar.gz"
      sha256 "c04356472e716a88d78eb7610f95a9a3de681a4b8efb802540d46af91cbf46fa"
    end
    on_intel do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-x86_64-apple-darwin.tar.gz"
      sha256 "90596f2ca51298b52ed4af5388c8b239b3a5c63c40e7b4beed638e97d2f76a83"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-x86_64-unknown-linux-gnu.tar.gz"
      sha256 "004cf341417f3976eba1b5d1b8c8ffb513a464447306afaa2a45a45467c36160"
    end
    on_arm do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-aarch64-unknown-linux-gnu.tar.gz"
      sha256 "a99bdee3f260daf3fc7ea6c570b8ff9bd4496bd63e245db307bceadecbcc0e6e"
    end
  end

  def install
    bin.install "dif"
  end

  test do
    assert_match "dif", shell_output("#{bin}/dif --help")
  end
end
