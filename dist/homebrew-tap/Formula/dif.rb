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
  version "0.5.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-aarch64-apple-darwin.tar.gz"
      sha256 "4695b4cc01f21c201a9fa1dee3e63bdfeb7a716c30d0b1fc0829acd43d5ff472"
    end
    on_intel do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-x86_64-apple-darwin.tar.gz"
      sha256 "b0d51e036ec65801bcaa7da467c5cfde6a2aaf6d3ec9ea72694564e86288b053"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-x86_64-unknown-linux-musl.tar.gz"
      sha256 "3fc4f605d7a4e3a32956c7a2172053f2775a68828511feac0ab763fc43fb9d5e"
    end
    on_arm do
      url "https://github.com/dif-sh/dif/releases/download/v#{version}/dif-aarch64-unknown-linux-musl.tar.gz"
      sha256 "e5700e4f9d0ffad8cf9de760e74fb6d41a9bc354c8965a78e43cdb40a96992f1"
    end
  end

  def install
    bin.install "dif"
  end

  test do
    assert_match "dif", shell_output("#{bin}/dif --help")
  end
end
