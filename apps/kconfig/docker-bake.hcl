variable "TREES" {
  default = [
    { id = "linux-7.3", name = "Linux 7.3", arches = ["arm64", "x86_64", "riscv"], src = "https://github.com/torvalds/linux.git#v7.3" },
    { id = "linux-6.18", name = "Linux 6.18", arches = ["arm64", "x86_64", "riscv"], src = "https://github.com/torvalds/linux.git#v6.18" },
    { id = "linux-6.12", name = "Linux 6.12", arches = ["arm64", "x86_64", "riscv"], src = "https://github.com/torvalds/linux.git#v6.12" },
    { id = "linux-6.6", name = "Linux 6.6", arches = ["arm64", "x86_64", "riscv"], src = "https://github.com/torvalds/linux.git#v6.6" },
    { id = "linux-6.1", name = "Linux 6.1", arches = ["arm64", "x86_64", "riscv"], src = "https://github.com/torvalds/linux.git#v6.1" },
    {
      id = "rockchip-6.12", name = "Rockchip 6.12", arches = ["arm64"],
      # renovate: branch=develop-6.12
      src = "https://github.com/rockchip-linux/kernel.git#470f9dccbdc42e7b8a824d0a5c5640a10e9457d2"
    },
    {
      id = "rockchip-6.6", name = "Rockchip 6.6", arches = ["arm64"],
      # renovate: branch=develop-6.6
      src = "https://github.com/rockchip-linux/kernel.git#1ba51b059f25533c5529b7f68186190b47d6a7b3"
    },
    {
      id = "rockchip-6.1", name = "Rockchip 6.1", arches = ["arm64"],
      # renovate: branch=develop-6.1
      src = "https://github.com/rockchip-linux/kernel.git#77168c8d5ab82399f65a80e9f807b50ba37cf483"
    },
  ]
}

target "default" {
  args = {
    TREES = jsonencode(TREES)
  }
}
