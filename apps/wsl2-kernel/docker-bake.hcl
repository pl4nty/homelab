target "default" {
  platforms = ["linux/amd64"]
  output    = ["type=image", "type=local,dest=dist,platform-split=false"]
  contexts = {
    # config-wsl is a 6.6 config, so track that branch rather than the default
    # renovate: branch=linux-msft-wsl-6.6.y
    src = "https://github.com/microsoft/WSL2-Linux-Kernel.git#a07f9ea8a99139913acbcc1c160b132cb2a49c81"
  }
}
