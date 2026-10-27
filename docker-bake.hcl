# One target for every app. CI sets APP (the folder, e.g. apps/hello) and TAG.
# An app's tests are stages its final image depends on, so building is testing.

variable "APP" {
  default = "apps/hello"
}

variable "TAG" {
  default = "dev"
}

# only main writes the cache, so PRs can't evict it
variable "CACHE_TO" {
  default = false
}

target "default" {
  context    = APP
  platforms  = ["linux/amd64", "linux/arm64"]
  tags       = ["ghcr.io/pl4nty/${basename(APP)}:${TAG}"]
  cache-from = ["type=gha,scope=${APP}"]
  cache-to   = CACHE_TO ? ["type=gha,mode=max,scope=${APP}"] : []
  labels = {
    "org.opencontainers.image.source" = "https://github.com/pl4nty/homelab"
  }
}
