# One experiment file, as written by hand. It passes dif validate.
# Renders assets/screenshots/experiment-file.png (1200x700). From the repo root:
#
#   docker run --rm -v "$PWD":/vhs dif-demo assets/screenshots/experiment-file.tape
#
# Same theme as assets/demo.tape. The project comes from setup.sh and fixture/.
# vhs always records a video as well; it goes to /tmp and is thrown away.

Output "/tmp/dif-screenshot-experiment-file.gif"

Require dif
Require git
Require perl

Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 700
Set Padding 20
Set TypingSpeed 5ms
Set CursorBlink false
Set Theme { "name": "dif", "black": "#0F2E29", "red": "#FF8A7A", "green": "#CBF56C", "yellow": "#F2D478", "blue": "#8FC7B8", "magenta": "#D7B8F5", "cyan": "#9FE3D0", "white": "#F3F1E7", "brightBlack": "#5E857C", "brightRed": "#FFA899", "brightGreen": "#DDFA9A", "brightYellow": "#F7E3A1", "brightBlue": "#B3DCD1", "brightMagenta": "#E6D2FA", "brightCyan": "#C2F0E3", "brightWhite": "#FFFFFF", "background": "#0F2E29", "foreground": "#F3F1E7", "selection": "#1B4B42", "cursor": "#CBF56C" }

# --- setup, not recorded ------------------------------------------------------
Hide
Type "source assets/screenshots/setup.sh && clear"
Enter
Sleep 2s
Show

Type "cat dif/experiments/active/guest-checkout-default.md"
Enter
Sleep 1s

Screenshot assets/screenshots/experiment-file.png
Sleep 500ms
