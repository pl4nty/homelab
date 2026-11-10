# kconfig

Search Linux Kconfig symbols and build a `.config` in the browser, across kernel versions and vendor trees such as [rockchip-linux/kernel](https://github.com/rockchip-linux/kernel) and SpacemiT's K1 ([Bianbu](https://gitee.com/bianbu-linux/linux-6.6)) and K3 ([spacemit-com/linux](https://github.com/spacemit-com/linux)) kernels.

- Start from any `*defconfig` in the tree, apply `*.config` fragments, or load your own `.config` (or `config.gz`) from a file or URL. `?config=<url>#<tree>/<arch>` links load a config on open. The URL's server must allow CORS; GitHub and GitLab file pages are rewritten to their raw URLs.
- Each symbol shows its value, help, source location, and why it has that value: dependencies, `select`/`imply` sources, defaults and ranges, each evaluated against the current config.
- "Available in" shows which trees and architectures define the symbol.
- "Hardening" runs [kernel-hardening-checker](https://github.com/a13xp0p0v/kernel-hardening-checker)'s Kconfig checks against the current config, and each symbol lists the checks that use it.
- Download a full `.config` or a minimal `defconfig` (`make savedefconfig` format). Changes are kept in the browser.

## Trees

`docker-bake.hcl` lists the trees and architectures. Renovate updates the pinned GitHub vendor branches; add mainline releases and update the Gitee SpacemiT K1 pin by hand.

The build fetches only `Kconfig*`, `scripts/`, `arch/*/configs/` and the top `Makefile` (a sparse, blobless clone takes seconds), then parses each architecture with [Kconfiglib](https://github.com/ulfalizer/Kconfiglib) and the cross GCC that `$(cc-option)` checks need. `index/kconfiglib.patch` adds syntax newer than Kconfiglib 14.1.0: `transitional` (6.18), bare `modules`, and `depends on X if Y`.

## Evaluator

`web/src/kconfig.js` ports Kconfiglib's value logic (visibility, defaults, `select`/`imply`, choices, ranges, `.config` and minimal config output). The build test loads every `*defconfig` of every indexed tree and checks the output matches Kconfiglib byte for byte.

The index exports kernel-hardening-checker's check list into `trees.json`, and `web/src/hardening.js` ports its check logic. The build test also checks its results for every `*defconfig` match the Python tool's.

## Develop

```sh
cd index && uv sync && patch "$(.venv/bin/python -c 'import kconfiglib; print(kconfiglib.__file__)')" kconfiglib.patch
.venv/bin/python index.py "$(docker buildx bake -f ../../docker-bake.hcl -f ../docker-bake.hcl --print | jq -r .target.default.args.TREES)" /tmp/work ../web/public/data /tmp/ref
cd ../web && cp public/data/trees.json src/ && npm ci && KCONFIG_REF=/tmp/ref npm test && npm run dev
```
