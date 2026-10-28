FROM --platform=$BUILDPLATFORM ubuntu:24.04@sha256:561618e2c15bf2397621dd04f96926663a3b5616c189cf7e38db7e82f5c538ea AS build
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# riscv64 packages are only on ports.ubuntu.com, so the default suites stay on the host architecture
COPY ubuntu-ports-riscv64.sources /etc/apt/sources.list.d/
RUN sed -i "/^Types: deb/a Architectures: $(dpkg --print-architecture)" /etc/apt/sources.list.d/ubuntu.sources \
  && dpkg --add-architecture riscv64 \
  && apt-get update && apt-get install -y --no-install-recommends \
  build-essential ca-certificates clang cmake crossbuild-essential-riscv64 curl file git gperf \
  libclang-dev llvm-dev m4 pkg-config python3

COPY build-riscv64-sysroot.sh /tmp/
RUN /tmp/build-riscv64-sysroot.sh
COPY riscv64-servo-gcc riscv64-servo-g++ /usr/local/bin/
COPY --from=ghcr.io/astral-sh/uv:0.13.6 /uv /usr/local/bin/

ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none

WORKDIR /servo
COPY --from=src . .
COPY servo-riscv64-cross.patch mozjs-riscv64-triple.patch /tmp/
RUN patch -p1 < /tmp/servo-riscv64-cross.patch \
  && rustup target add riscv64gc-unknown-linux-gnu \
  && cargo fetch --locked \
  && patch -d "$(echo "$CARGO_HOME"/registry/src/*/mozjs_sys-*/)" -p1 < /tmp/mozjs-riscv64-triple.patch

ENV RV_SYSROOT=/opt/riscv64-sysroot \
  CARGO_TARGET_RISCV64GC_UNKNOWN_LINUX_GNU_LINKER=riscv64-servo-gcc \
  CC_riscv64gc_unknown_linux_gnu=riscv64-servo-gcc \
  CXX_riscv64gc_unknown_linux_gnu=riscv64-servo-g++ \
  AR_riscv64gc_unknown_linux_gnu=riscv64-linux-gnu-ar \
  RANLIB_riscv64gc_unknown_linux_gnu=riscv64-linux-gnu-ranlib \
  CC_riscv64_unknown_linux_gnu=riscv64-servo-gcc \
  CXX_riscv64_unknown_linux_gnu=riscv64-servo-g++ \
  CPP_riscv64gc_unknown_linux_gnu="riscv64-servo-gcc -E" \
  HOST_CC=cc \
  HOST_CXX=c++ \
  PKG_CONFIG_ALLOW_CROSS=1 \
  PKG_CONFIG_SYSROOT_DIR=/opt/riscv64-sysroot \
  PKG_CONFIG_LIBDIR=/opt/riscv64-sysroot/usr/lib/riscv64-linux-gnu/pkgconfig:/opt/riscv64-sysroot/usr/share/pkgconfig \
  BINDGEN_EXTRA_CLANG_ARGS_riscv64gc_unknown_linux_gnu="--target=riscv64-unknown-linux-gnu --sysroot=/usr/riscv64-linux-gnu --gcc-toolchain=/usr -I/opt/riscv64-sysroot/usr/include -I/opt/riscv64-sysroot/usr/include/riscv64-linux-gnu" \
  MOZ_TARGET=riscv64-unknown-linux-gnu \
  MOZJS_FROM_SOURCE=1 \
  LIBZ_SYS_STATIC=1
RUN ./mach build --release --target riscv64gc-unknown-linux-gnu \
  && file target/riscv64gc-unknown-linux-gnu/release/servoshell | grep -q 'UCB RISC-V'

FROM scratch
COPY --from=build /servo/target/riscv64gc-unknown-linux-gnu/release/servoshell /servoshell-linux-riscv64
