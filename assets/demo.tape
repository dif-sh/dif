# dif README demo. Renders assets/demo.gif (about 29 seconds, 1200x700).
#
# Render, from the repo root, with dif 0.6.3 on PATH:
#
#   vhs assets/demo.tape
#
# Or without installing vhs, ttyd and ffmpeg (Docker; the image bundles dif):
#
#   docker build -t dif-demo -f assets/demo.Dockerfile assets
#   docker run --rm -v "$PWD":/vhs dif-demo assets/demo.tape
#
# Needs charmbracelet/vhs (https://github.com/charmbracelet/vhs), plus git and
# perl, which macOS and most Linux distros ship. The recording runs in a fresh
# temp directory, so it never touches this repo.
#
# Every command below was run against dif 0.6.3 and produced the output the
# storyboard describes:
#   1. dif init            scaffolds dif/ and the agent files
#   2. dif new + dif build one active experiment, build passes
#   3. second experiment on the same surface: dif build exits 1 with E007
#   4. add exclusion_group to both files: dif build passes
#
# `--events custom` is passed so `dif init` does not stop at its interactive
# "How should dif deliver events?" prompt.

Output assets/demo.gif

Require dif
Require git
Require perl

Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 700
Set Padding 28
Set TypingSpeed 30ms
Set Theme { "name": "dif", "black": "#0F2E29", "red": "#FF8A7A", "green": "#CBF56C", "yellow": "#F2D478", "blue": "#8FC7B8", "magenta": "#D7B8F5", "cyan": "#9FE3D0", "white": "#F3F1E7", "brightBlack": "#5E857C", "brightRed": "#FFA899", "brightGreen": "#DDFA9A", "brightYellow": "#F7E3A1", "brightBlue": "#B3DCD1", "brightMagenta": "#E6D2FA", "brightCyan": "#C2F0E3", "brightWhite": "#FFFFFF", "background": "#0F2E29", "foreground": "#F3F1E7", "selection": "#1B4B42", "cursor": "#CBF56C" }

# --- setup, not recorded ------------------------------------------------------
Hide
Type "cd $(mktemp -d) && git init -q && git config user.email dev@example.com && clear"
Enter
Sleep 1s
Show

# --- 1. scaffold --------------------------------------------------------------
Type "dif init --events custom"
Sleep 300ms
Enter
Sleep 3s

Hide
Type "clear"
Enter
Sleep 300ms
Show

# --- 2. author one experiment, build ------------------------------------------
Type "dif new new-checkout --surface home"
Sleep 300ms
Enter
Sleep 1.5s

Type@15ms "perl -pi -e 's/status: draft/status: active/' dif/experiments/active/*.md"
Sleep 300ms
Enter
Sleep 500ms

Type "dif build"
Sleep 300ms
Enter
Sleep 2.5s

Hide
Type "clear"
Enter
Sleep 300ms
Show

# --- 3. a second experiment on the same surface: the build refuses ------------
Type "dif new home-hero-cta --surface home"
Sleep 300ms
Enter
Sleep 1s

Type@15ms "perl -pi -e 's/status: draft/status: active/' dif/experiments/active/*.md"
Sleep 300ms
Enter
Sleep 500ms

Type "dif build"
Sleep 300ms
Enter
Sleep 5s

# --- 4. fix: put both in one exclusion group, rebuild -------------------------
Type@15ms `perl -lpi -e 'print "exclusion_group: home" if /^metrics:/' dif/experiments/active/*.md`
Sleep 300ms
Enter
Sleep 500ms

Type "dif build"
Sleep 300ms
Enter
Sleep 4s
