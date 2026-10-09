# Terminal screenshots

Real output from dif 0.6.3, captured with [vhs](https://github.com/charmbracelet/vhs). Each PNG is 1200x700 and has a tape of the same name next to it.

| Image | What it shows |
| --- | --- |
| `build-pass.png` | `dif validate` and `dif build` passing with two active experiments on one surface, both in `exclusion_group: checkout`. |
| `clash-e007.png` | `dif build` refusing with `E007` and exit code 1 after `exclusion_group` is removed from both files. |
| `experiment-file.png` | `cat` of one experiment file: hypothesis, audience, variants, weights, metrics and `exclusion_group`. |
| `qa.png` | `dif qa --user u_204` three ways: desktop, `--attr device_type=mobile`, and `--force express-pay-button=on` with its preview URL. |

## Render

From the repo root. The `dif-demo` image is the one `assets/demo.tape` uses.

```sh
docker build -t dif-demo -f assets/demo.Dockerfile assets
for t in build-pass clash-e007 experiment-file qa; do
  docker run --rm -v "$PWD":/vhs dif-demo assets/screenshots/$t.tape
done
```

Without Docker, with vhs and dif 0.6.3 on PATH: `vhs assets/screenshots/qa.tape`.

## How it works

- `setup.sh` builds a throwaway project in a temp directory: `dif init --surface checkout --events custom --agents none`, then copies `fixture/*.md` into `dif/experiments/active/`. `setup.sh clash` also strips `exclusion_group` from both files.
- `fixture/` holds the two experiment files. Both pass `dif validate` as written.
- Each tape sources `setup.sh` inside `Hide` / `Show`, so no setup appears in the image.
- `clash-e007.tape` depends on its width. At 94 columns the two long E007 lines wrap between words. If you rename an experiment or change the font size, look at the PNG again.
