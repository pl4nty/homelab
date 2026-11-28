target "default" {
  platforms = ["linux/amd64"]
  output    = ["type=image", "type=local,dest=dist,platform-split=false"]
  # mode=max would export the multi-GB build tree (15 min), which a new kernel commit misses anyway
  cache-to = CACHE_TO ? ["type=registry,ref=ghcr.io/pl4nty/${APP}:buildcache,mode=min,ignore-error=true"] : []
  contexts = {
    # config-wsl is copied from this branch's arch/x86/configs/config-wsl
    # renovate: branch=linux-msft-wsl-6.18.y
    src = "https://github.com/microsoft/WSL2-Linux-Kernel.git#4ee82e228f384c4335f6b2048af72d6956f74c21"
  }
}
