variable "APP" {}

variable "TAG" {
  default = "dev"
}

variable "LATEST" {
  default = false
}

variable "CACHE_TO" {
  default = false
}

# apps that ship files set output = ["type=image", "type=local,dest=dist,platform-split=false"], and CI releases dist/
target "default" {
  context    = "apps/${APP}"
  platforms  = ["linux/amd64", "linux/arm64"]
  tags       = concat(["ghcr.io/pl4nty/${APP}:${TAG}"], LATEST ? ["ghcr.io/pl4nty/${APP}:latest"] : [])
  # registry, not gha: GitHub hides PR caches from main, so the merge build couldn't reuse the PR's layers
  cache-from = ["type=registry,ref=ghcr.io/pl4nty/${APP}:buildcache"]
  cache-to   = CACHE_TO ? ["type=registry,ref=ghcr.io/pl4nty/${APP}:buildcache,mode=max,ignore-error=true"] : []
  labels = {
    "org.opencontainers.image.source" = "https://github.com/pl4nty/homelab"
  }
}
