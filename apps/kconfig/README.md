# kconfig

Search Linux Kconfig symbols and build a `.config` in the browser, across kernel versions and vendor trees such as [rockchip-linux/kernel](https://github.com/rockchip-linux/kernel) and SpacemiT's K1 ([Bianbu](https://gitee.com/bianbu-linux/linux-6.6)) and K3 ([spacemit-com/linux](https://github.com/spacemit-com/linux)) kernels.

- Start from any `*defconfig` in the tree, apply `*.config` fragments, or load your own `.config` (or `config.gz`) from a file or an https URL. `/<tree>/<arch>?config=<url>` links load a config on open; GitHub and GitLab file pages are rewritten to their raw URLs.
- Each symbol shows its value, help, source location, and why it has that value: dependencies, `select`/`imply` sources, defaults and ranges, each evaluated against the current config.
- "Available in" shows which trees and architectures define the symbol.
- "Hardening" runs [kernel-hardening-checker](https://github.com/a13xp0p0v/kernel-hardening-checker)'s Kconfig checks against the current config, and each symbol lists the checks that use it.
- Download a full `.config` or a minimal `defconfig` (`make savedefconfig` format). Changes are kept per browser until the server restarts.

## Trees

`docker-bake.hcl` lists the trees and architectures. Renovate updates the pinned GitHub vendor branches; add mainline releases and update the Gitee SpacemiT K1 pin by hand.

`build.py` fetches only `Kconfig*`, `scripts/`, `arch/*/configs/` and the top `Makefile` (a sparse, blobless clone takes seconds), then parses each architecture with [Kconfiglib](https://github.com/ulfalizer/Kconfiglib) and the cross GCC that `$(cc-option)` checks need, and pickles the result. `kconfiglib.patch` adds syntax newer than Kconfiglib 14.1.0: `transitional` (6.18), bare `modules`, and `depends on X if Y`.

## App

`app.py` is a [NiceGUI](https://nicegui.io) server. It unpickles a tree on first use and keeps the last few in memory; requests share one Kconfiglib instance per tree and load the visitor's config into it before each render.

## Develop

```sh
uv sync && patch .venv/lib/python3.14/site-packages/kconfiglib.py kconfiglib.patch
.venv/bin/python build.py "$(docker buildx bake -f ../docker-bake.hcl -f docker-bake.hcl --print | jq -r .target.default.args.TREES)" /tmp/work /tmp/data
KCONFIG_DATA=/tmp/data .venv/bin/python app.py
```
