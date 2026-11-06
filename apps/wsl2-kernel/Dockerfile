# https://github.com/microsoft/WSL2-Linux-Kernel/tree/linux-msft-wsl-6.18.y#build-instructions
# download bzImage from the latest wsl2-kernel/sha-* release
FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852 AS build

RUN --mount=type=cache,id=apt-cache-noble,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,id=apt-lists-noble,target=/var/lib/apt,sharing=locked \
  apt update && apt-get --no-install-recommends install -y \
  build-essential flex bison dwarves libssl-dev libelf-dev cpio \
  libncurses-dev bc python3 openssl

WORKDIR /app
COPY --from=src . .
COPY config-wsl .
RUN make -j"$(nproc)" KCONFIG_CONFIG=config-wsl

# docker run -it --rm -v $(pwd)/config-wsl:/app/config-wsl kernel make menuconfig KCONFIG_CONFIG=config-wsl
FROM scratch
COPY --from=build /app/arch/x86/boot/bzImage /bzImage
