# https://github.com/microsoft/WSL2-Linux-Kernel/tree/linux-msft-wsl-6.6.y#build-instructions
# docker image save ghcr.io/pl4nty/wsl2-kernel --output .\kernel.tar
# tar -xvf .\kernel.tar blobs\sha256\
# Get-ChildItem .\blobs\sha256\ | Sort-Object Length -Descending | select -First 1 | ForEach-Object { tar -xvf .\blobs\sha256\$_ }
FROM ubuntu:24.04 AS build

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt,sharing=locked \
  apt update && apt-get --no-install-recommends install -y \
  build-essential flex bison dwarves libssl-dev libelf-dev cpio \
  libncurses-dev bc python3 openssl

WORKDIR /app
ADD https://github.com/microsoft/WSL2-Linux-Kernel.git /app
COPY config-wsl .
RUN make KCONFIG_CONFIG=config-wsl

# docker run -it --rm -v $(pwd)/config-wsl:/app/config-wsl kernel make menuconfig KCONFIG_CONFIG=config-wsl
FROM scratch
COPY --from=build /app/arch/x86/boot/bzImage /bzImage
