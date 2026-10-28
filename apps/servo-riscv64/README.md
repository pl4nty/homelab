# Cross-compiling Servo for RISC-V (`riscv64gc-unknown-linux-gnu`)

Reproducible recipe for building [servo/servo](https://github.com/servo/servo) for
64-bit RISC-V from an **x86_64 Ubuntu 24.04 (noble)** host. The `Dockerfile` runs every step
below, and CI attaches `servoshell-linux-riscv64` to the `servo-riscv64/sha-*` releases.

**Result:** a working 176 MB `servoshell` ELF — `Machine: RISC-V`, RVC + double-float
ABI (`rv64gc`/`lp64d`), interpreter `/lib/ld-linux-riscv64-lp64d.so.1` — that runs
under `qemu-riscv64`.

Servo has no RISC-V CI and publishes no RISC-V binaries, but the tree already carries
`target_arch = "riscv32"` / `"riscv64"` `cfg` gates (they exclude the x86-only `gaol`
sandbox), so the port is anticipated upstream.

Built at servo/servo `aa297ce51`, mozjs_sys 140.12.0-2 (SpiderMonkey 140 ESR), Rust 1.95.0.

## Blockers hit, and why

### 1. `mozjs_sys` hands Rust's target triple to autoconf

SpiderMonkey's `config.sub` rejects it:

```
Invalid configuration 'riscv64gc-unknown-linux-gnu': machine 'riscv64gc-unknown' not recognized
```

`makefile.cargo` already performs exactly this Rust→GNU triple remap for `armv7-*` and
`aarch64-unknown-linux-gnu` — RISC-V was simply never added. With the remap to
`riscv64-linux-gnu`, SpiderMonkey cross-compiles cleanly with no source changes:
RISC-V support is already there. See `mozjs-riscv64-triple.patch`.

### 2. `mach` rejects Linux-to-Linux cross builds

`BuildTarget.from_triple` only accepts Android, OpenHarmony, or the host triple, and
raises `Unknown build target` for anything else. `servo-riscv64-cross.patch` adds a
`LinuxCrossTarget`; everything such a build needs already comes from the environment.

### 3. Sysroot headers shadowing vendored copies

Injecting the sysroot with `-I` puts it ahead of every crate's own include path, so
vendored headers lose:

- bundled ANGLE (`mozangle`) ships its own `EGL/eglext.h` with the `EGL_*_ANGLE`
  extension constants; Mesa's `eglext.h` shadowed it →
  `'EGL_TEXTURE_RECTANGLE_ANGLE' was not declared in this scope`
- `aws-lc-sys` ships vendored BoringSSL `openssl/*.h`; the sysroot's real OpenSSL
  shadowed those → `storage class specified for parameter 'AES_KEY'`

Fix: use **`-isystem`**, which GCC searches *after* every `-I` directory, so a vendored
copy always wins. This is the single most important detail in the wrappers.

### 4. SpiderMonkey's hidden symbols require *static* zlib and unwinder

The final link failed with:

```
undefined reference to `deflate' / `inflateInit2_' / `_Unwind_GetIP'
hidden symbol `deflate' isn't defined
```

`libjs_static.a` is compiled with `-fvisibility=hidden`, so its undefined references to
zlib and the unwinder are **hidden** — and a hidden reference cannot be bound to a
*shared* library. Both need static definitions:

- `LIBZ_SYS_STATIC=1` makes `libz-sys` build and link zlib statically. Upstream mozjs
  assumes this: its `build.rs` only wires up `DEP_Z_ROOT`, which `libz-sys` sets only
  when it builds zlib from source. Left alone in a cross build, `libz-sys` finds the
  sysroot's *shared* zlib via pkg-config and the link fails.
- The wrappers append `-lgcc_eh` when linking, for the static unwinder.

### Not a blocker: GStreamer

`mach` sets `media_stack = "dummy"` for **any** cross build
(`python/servo/command_base.py`, `is_media_enabled`), so the entire GStreamer
dependency tree — by far the worst part of a RISC-V sysroot — drops out automatically.

## Steps

### 1. Enable the RISC-V ports archive

`archive.ubuntu.com` has no RISC-V; Ubuntu ships it via `ports.ubuntu.com`.

```bash
# Pin the existing suites to amd64 so apt doesn't 404 looking for riscv64 there.
sed -i '/^Types: deb/a Architectures: amd64' /etc/apt/sources.list.d/ubuntu.sources

cat > /etc/apt/sources.list.d/ubuntu-ports-riscv64.sources <<'EOF'
Types: deb
Architectures: riscv64
URIs: http://ports.ubuntu.com/ubuntu-ports/
Suites: noble noble-updates noble-backports noble-security
Components: main universe restricted multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF

dpkg --add-architecture riscv64
apt-get update
```

### 2. Cross toolchain

```bash
apt-get install -y --no-install-recommends crossbuild-essential-riscv64
```

Gives `riscv64-linux-gnu-gcc/g++` (GCC 13) with libc and libstdc++ under
`/usr/riscv64-linux-gnu`.

### 3. Library sysroot

```bash
./build-riscv64-sysroot.sh      # -> /opt/riscv64-sysroot (~400 MB)
```

Resolves the recursive `.deb` closure for X11/XCB, Wayland, Mesa (GL/EGL/GLES),
fontconfig, FreeType, `libudev`, D-Bus, OpenSSL, `liblzma`, `zlib`, `libunwind` and
Vulkan, extracts it, and relativizes absolute symlinks so the tree works as a sysroot.

Two Ubuntu packaging wrinkles worth knowing:

- `apt` multiarch **cannot** install `libglib2.0-dev:riscv64` — it depends on
  `libglib2.0-dev-bin`, a host-arch tool that conflicts with the amd64 copy.
  Downloading the `.deb` closure and `dpkg -x`-ing it bypasses dependency resolution
  entirely, which is why the script works this way.
- `Architecture: all` packages (X11 protocol headers, `xkb-data`, …) have no
  `:riscv64` variant, so `apt-get download <pkg>:riscv64` fails on them; they need a
  second unqualified pass.

### 4. Compiler wrappers

Install `riscv64-servo-gcc` / `riscv64-servo-g++` to `/usr/local/bin`. They wrap the
cross compilers, add the library sysroot with `-isystem` (see blocker 3), and append
`-lgcc_eh` when linking (blocker 4). Keeping this in a wrapper rather than `RUSTFLAGS`
means the flags survive every build script, `cc-rs` invocation and the final link — and
crucially, changing them does **not** invalidate cargo's fingerprints and force a full
rebuild, which editing `RUSTFLAGS` would.

### 5. Rust target

```bash
cd servo
rustup target add riscv64gc-unknown-linux-gnu   # for the pinned 1.95.0 toolchain
```

### 6. Patch and build

```bash
cd servo
patch -p1 < /path/to/servo-riscv64-cross.patch  # mach LinuxCrossTarget
cargo fetch --locked
# patch the mozjs_sys that cargo fetched, in place
patch -d "$CARGO_HOME"/registry/src/*/mozjs_sys-*/ -p1 < /path/to/mozjs-riscv64-triple.patch

# set the ENV block from the Dockerfile (CC_*, pkg-config, bindgen, LIBZ_SYS_STATIC)
./mach build --release --target riscv64gc-unknown-linux-gnu
```

Roughly 45 min wall-clock on 4 cores / 15 GB RAM, ~25 GB of disk (the Docker build took 27 min to compile and left ~21 GB of build cache). SpiderMonkey alone
is ~9 min.

## Verification

```
$ file servoshell
ELF 64-bit LSB pie executable, UCB RISC-V, RVC, double-float ABI, version 1 (GNU/Linux),
dynamically linked, interpreter /lib/ld-linux-riscv64-lp64d.so.1

$ readelf -h servoshell | grep -E 'Machine|Flags'
  Machine:  RISC-V
  Flags:    0x5, RVC, double-float ABI

$ readelf -d servoshell | grep NEEDED
  libudev.so.1  libstdc++.so.6  libfontconfig.so.1  libgcc_s.so.1
  libm.so.6     libc.so.6       ld-linux-riscv64-lp64d.so.1
```

It also **executes** under emulation — `qemu-riscv64-static -L <runtime-root> servoshell
--help` prints Servo's full option list, and a headless render run gets as far as
`App::create_platform_window` before failing on
`Failed to create WR surfman: ConnectionFailed`. That last step is a limitation of
qemu-user in a container with no DRM device — surfman needs a real GPU/display — not a
defect in the binary. Rendering was **not** verified on real RISC-V hardware.

## Files

| File | Purpose |
| --- | --- |
| `build-riscv64-sysroot.sh` | Builds the riscv64 sysroot from Ubuntu ports `.deb`s |
| `Dockerfile` | Runs the whole recipe; its `ENV` block is the cross-build environment |
| `ubuntu-ports-riscv64.sources` | The riscv64 ports archive |
| `riscv64-servo-gcc`, `riscv64-servo-g++` | Sysroot-injecting compiler wrappers |
| `mozjs-riscv64-triple.patch` | Rust→GNU triple remap for `servo/mozjs` |
| `servo-riscv64-cross.patch` | `LinuxCrossTarget` for `servo/servo` |

Both patches are small and upstreamable; the `mozjs` one in particular just fills a gap
next to the existing `armv7`/`aarch64` cases.
