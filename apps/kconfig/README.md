# kconfig

Search Linux Kconfig symbols and build a `.config` in the browser, across kernel versions and vendor trees such as [rockchip-linux/kernel](https://github.com/rockchip-linux/kernel).

- Start from any `*defconfig` in the tree, apply `*.config` fragments, or load your own `.config`.
- Each symbol shows its value, help, source location, and why it has that value: dependencies, `select`/`imply` sources, defaults and ranges, each evaluated against the current config.
- "Available in" shows which trees and architectures define the symbol.
- Download a full `.config` or a minimal `defconfig` (`make savedefconfig` format). Changes are kept in the browser.

## Trees

`docker-bake.hcl` lists the trees and architectures. Renovate updates the pinned vendor branches; add mainline releases by hand.

The build fetches only `Kconfig*`, `scripts/`, `arch/*/configs/` and the top `Makefile` (a sparse, blobless clone takes seconds), then parses each architecture with [Kconfiglib](https://github.com/ulfalizer/Kconfiglib) and the cross GCC that `$(cc-option)` checks need. `index/kconfiglib.patch` adds syntax newer than Kconfiglib 14.1.0: `transitional` (6.18), bare `modules`, and `depends on X if Y`.

## Evaluator

`web/src/kconfig.js` ports Kconfiglib's value logic (visibility, defaults, `select`/`imply`, choices, ranges, `.config` and minimal config output). The build test loads every `*defconfig` of every indexed tree and checks the output matches Kconfiglib byte for byte.

## Develop

```sh
cd index && uv sync && patch "$(.venv/bin/python -c 'import kconfiglib; print(kconfiglib.__file__)')" kconfiglib.patch
.venv/bin/python index.py "$(docker buildx bake -f ../../docker-bake.hcl -f ../docker-bake.hcl --print | jq -r .target.default.args.TREES)" /tmp/work ../web/public/data /tmp/ref
cd ../web && cp public/data/trees.json src/ && npm ci && KCONFIG_REF=/tmp/ref npm test && npm run dev
```
