target "default" {
  platforms = ["linux/amd64"]
  output    = ["type=image", "type=local,dest=dist,platform-split=false"]
  # mode=max would export the multi-GB build tree (15 min), which a new kernel commit misses anyway
  cache-to = CACHE_TO ? ["type=registry,ref=ghcr.io/pl4nty/${APP}:buildcache,mode=min,ignore-error=true"] : []
  contexts = {
    # renovate: branch=linux-msft-wsl-6.18.y
    src = "https://github.com/microsoft/WSL2-Linux-Kernel.git#a989171929bed4ea681be8d77333845ce1c1732a"
  }
}
