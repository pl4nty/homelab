#!/bin/bash
# Build a riscv64 sysroot for cross-compiling Servo, from Ubuntu ports .debs.
set -euo pipefail

SYSROOT=/opt/riscv64-sysroot
DEBDIR=/tmp/riscv64-debs
ARCH=riscv64

PKGS="
libx11-dev
libxcb1-dev
libxcb-render0-dev
libxcb-shape0-dev
libxcb-xfixes0-dev
libxext-dev
libxrender-dev
libxfixes-dev
libxrandr-dev
libxi-dev
libxcursor-dev
libxinerama-dev
libxmu-dev
libxt-dev
libxkbcommon-dev
libxkbcommon-x11-dev
libwayland-dev
libgl-dev
libegl-dev
libgles-dev
libglvnd-dev
libfontconfig-dev
libfreetype-dev
libudev-dev
libdbus-1-dev
liblzma-dev
zlib1g-dev
libunwind-dev
libssl-dev
libvulkan-dev
libexpat1-dev
libpng-dev
libbz2-dev
libbrotli-dev
"

mkdir -p "$DEBDIR" "$SYSROOT"

echo "== resolving dependency closure =="
CLOSURE=""
for p in $PKGS; do
  # skip packages that don't exist for this arch
  if ! apt-cache show "${p}:${ARCH}" >/dev/null 2>&1; then
    echo "  (skip, unavailable: $p)"
    continue
  fi
  deps=$(apt-cache depends --recurse --no-recommends --no-suggests \
           --no-conflicts --no-breaks --no-replaces --no-enhances \
           "${p}:${ARCH}" 2>/dev/null \
         | grep -E '^[a-zA-Z0-9]' | sed 's/:.*//' | sort -u)
  CLOSURE="$CLOSURE
$deps"
done

# Drop host-tool / non-library packages that pull in the world or are amd64-only helpers.
CLOSURE=$(echo "$CLOSURE" | sort -u | grep -v '^$' | grep -vE \
  '^(python3.*|perl.*|debconf.*|dpkg|gcc-.*|libgcc-.*-dev|cpp-.*|.*-doc|install-info|dpkg-dev|make|sensible-utils|ucf|adduser|passwd|init-system-helpers|libc-dev-bin|libc6-dev|linux-libc-dev|gcc|g\+\+|.*-bin-linux|libglib2\.0-dev-bin)$')

echo "== $(echo "$CLOSURE" | wc -l) packages in closure =="

echo "== downloading =="
cd "$DEBDIR"
FAILED=""
# download in batches so one bad name doesn't kill everything
for p in $CLOSURE; do
  if ls "${p}"_*_"${ARCH}".deb >/dev/null 2>&1 || ls "${p}"_*_all.deb >/dev/null 2>&1; then continue; fi
  apt-get download "${p}:${ARCH}" >/dev/null 2>&1 || FAILED="$FAILED $p"
done
# Architecture: all packages have no :riscv64 variant
RETRY=$FAILED
FAILED=""
for p in $RETRY; do
  apt-get download "$p" >/dev/null 2>&1 || FAILED="$FAILED $p"
done
echo "failed downloads:${FAILED:- none}"

echo "== extracting into $SYSROOT =="
for deb in "$DEBDIR"/*.deb; do
  dpkg -x "$deb" "$SYSROOT" 2>/dev/null || echo "  extract failed: $(basename "$deb")"
done

echo "== relativizing absolute symlinks =="
python3 - "$SYSROOT" <<'PY'
import os, sys
root = os.path.abspath(sys.argv[1])
fixed = 0
for dirpath, dirnames, filenames in os.walk(root):
    for name in filenames + dirnames:
        p = os.path.join(dirpath, name)
        if not os.path.islink(p):
            continue
        t = os.readlink(p)
        if not t.startswith('/'):
            continue
        new = os.path.relpath(os.path.join(root, t.lstrip('/')), dirpath)
        os.remove(p)
        os.symlink(new, p)
        fixed += 1
print(f"  relativized {fixed} symlinks")
PY

echo "== sysroot size =="
du -sh "$SYSROOT"
echo "== sample pkgconfig files =="
ls "$SYSROOT"/usr/lib/riscv64-linux-gnu/pkgconfig/ 2>/dev/null | head -30
