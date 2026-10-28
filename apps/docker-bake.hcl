variable "APP" {}

variable "TAG" {
  default = "dev"
}

variable "CACHE_TO" {
  default = false
}

target "default" {
  context    = "apps/${APP}"
  platforms  = ["linux/amd64", "linux/arm64"]
  tags       = ["ghcr.io/pl4nty/${APP}:${TAG}"]
  cache-from = ["type=gha,scope=${APP}"]
  cache-to   = CACHE_TO ? ["type=gha,mode=max,scope=${APP}"] : []
  labels = {
    "org.opencontainers.image.source" = "https://github.com/pl4nty/homelab"
  }
}
