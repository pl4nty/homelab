target "default" {
  platforms = ["linux/amd64"]
  output    = ["type=image", "type=local,dest=dist,platform-split=false"]
  contexts = {
    # config-wsl is copied from this branch's arch/x86/configs/config-wsl
    # renovate: branch=linux-msft-wsl-6.18.y
    src = "https://github.com/microsoft/WSL2-Linux-Kernel.git#a989171929bed4ea681be8d77333845ce1c1732a"
  }
}
