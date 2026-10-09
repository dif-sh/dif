# dif build refusing with E007: two active experiments on one surface, no
# shared exclusion_group. FontSize 20 with Padding 20 gives 94 columns, and at
# 94 columns both long lines wrap between words for these two experiment ids.
# Change an id, the font size or the padding and check the wrap again.
# Renders assets/screenshots/clash-e007.png (1200x700). From the repo root:
#
#   docker run --rm -v "$PWD":/vhs dif-demo assets/screenshots/clash-e007.tape
#
# Same theme as assets/demo.tape. The project comes from setup.sh and fixture/.
# vhs always records a video as well; it goes to /tmp and is thrown away.

Output "/tmp/dif-screenshot-clash-e007.gif"

Require dif
Require git
Require perl

Set Shell "bash"
Set FontSize 20
Set Width 1200
Set Height 700
Set Padding 20
Set TypingSpeed 5ms
Set CursorBlink false
Set Theme { "name": "dif", "black": "#0F2E29", "red": "#FF8A7A", "green": "#CBF56C", "yellow": "#F2D478", "blue": "#8FC7B8", "magenta": "#D7B8F5", "cyan": "#9FE3D0", "white": "#F3F1E7", "brightBlack": "#5E857C", "brightRed": "#FFA899", "brightGreen": "#DDFA9A", "brightYellow": "#F7E3A1", "brightBlue": "#B3DCD1", "brightMagenta": "#E6D2FA", "brightCyan": "#C2F0E3", "brightWhite": "#FFFFFF", "background": "#0F2E29", "foreground": "#F3F1E7", "selection": "#1B4B42", "cursor": "#CBF56C" }

# --- setup, not recorded. The PS1 change puts a blank line between commands. ---
Hide
Type `source assets/screenshots/setup.sh clash && PS1="\n$PS1" && clear`
Enter
Sleep 2s
Show

Type "dif build"
Enter
Sleep 2s

Type "echo $?"
Enter
Sleep 500ms

Screenshot assets/screenshots/clash-e007.png
Sleep 500ms
