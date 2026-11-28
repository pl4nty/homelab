import gzip
import json
import os
import pickle
import re
import subprocess
import sys
import threading
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import kconfiglib

SPARSE = ["/Makefile", "**/Kconfig*", "/scripts/", "/arch/*/configs/"]
SRCARCH = {"x86_64": "x86", "i386": "x86"}
CROSS = {
    "arm64": "aarch64-linux-gnu-",
    "riscv": "riscv64-linux-gnu-",
    "arm": "arm-linux-gnueabihf-",
}


def fetch(src, dest):
    url, ref = src.split("#")
    git = ["git", "-C", str(dest)]
    dest.mkdir(parents=True)
    subprocess.run([*git, "init", "-q"], check=True)
    subprocess.run([*git, "sparse-checkout", "set", "--no-cone", *SPARSE], check=True)
    fetch = [*git, "fetch", "-q", "--depth=1", "--filter=blob:none", url, ref]
    checkout = [*git, "checkout", "-q", "FETCH_HEAD"]
    for _ in range(3):
        if (
            not subprocess.run(fetch, check=False).returncode
            and not subprocess.run(checkout, check=False).returncode
        ):
            break
    else:
        raise RuntimeError(f"couldn't fetch {src}")
    commit = subprocess.run(
        [*git, "rev-parse", "HEAD"], check=True, capture_output=True, text=True
    ).stdout.strip()
    make = (dest / "Makefile").read_text()
    parts = [
        re.search(rf"^{k} = (\S*)", make, re.MULTILINE)
        for k in ("VERSION", "PATCHLEVEL", "SUBLEVEL")
    ]
    version = ".".join(m.group(1) for m in parts if m and m.group(1))
    return url.removesuffix(".git"), commit, version


def load(src, arch, version):
    cross = CROSS.get(arch, "")
    os.environ.update(
        srctree=str(src),
        ARCH=arch,
        SRCARCH=SRCARCH.get(arch, arch),
        KERNELVERSION=version,
        CC=f"{cross}gcc",
        LD=f"{cross}ld",
        HOSTCC="gcc",
        HOSTCXX="g++",
        RUSTC="rustc",
        BINDGEN="bindgen",
        PAHOLE="pahole",
    )
    os.chdir(src)
    return kconfiglib.Kconfig("Kconfig", warn=False)


def dump(kconf, path):
    kconf._readline = None
    out = []
    sys.setrecursionlimit(1_000_000)
    threading.stack_size(1 << 30)
    thread = threading.Thread(target=lambda: out.append(pickle.dumps(kconf, protocol=5)))
    thread.start()
    thread.join()
    path.write_bytes(gzip.compress(out[0], mtime=0))


def index_arch(job):
    src, out, tree, arch, version = job
    kconf = load(src, arch, version)
    configs = src / "arch" / SRCARCH.get(arch, arch) / "configs"
    names = sorted(p.name for p in configs.iterdir()) if configs.is_dir() else []
    arch_out = out / tree / arch
    arch_out.mkdir(parents=True)
    for name in names:
        (arch_out / name).write_bytes((configs / name).read_bytes())
    syms = [s.name for s in kconf.unique_defined_syms]
    dump(kconf, out / tree / f"{arch}.pickle.gz")
    return tree, arch, syms, names


def main():
    trees = json.loads(sys.argv[1])
    work, out = (Path(p).resolve() for p in sys.argv[2:4])
    jobs = []
    manifest = []
    for tree in trees:
        repo, commit, version = fetch(tree["src"], work / tree["id"])
        manifest.append(
            {k: tree[k] for k in ("id", "name", "arches")}
            | {"repo": repo, "commit": commit, "version": version, "configs": {}}
        )
        jobs += [(work / tree["id"], out, tree["id"], a, version) for a in tree["arches"]]
    names = {}
    with ProcessPoolExecutor() as pool:
        for tree, arch, syms, configs in pool.map(index_arch, jobs):
            next(t for t in manifest if t["id"] == tree)["configs"][arch] = configs
            for name in syms:
                names.setdefault(name, []).append(f"{tree}/{arch}")
    (out / "trees.json").write_text(json.dumps({"trees": manifest, "names": names}))


if __name__ == "__main__":
    main()
