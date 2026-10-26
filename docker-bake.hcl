# One definition for every app under apps/. CI passes APP, TAGS and PLATFORMS.
# Local use: APP=hello docker buildx bake test
#            APP=hello docker buildx bake --call check

variable "APP" {
  default = "hello"
}

variable "REGISTRY" {
  default = "ghcr.io/pl4nty"
}

# comma-separated, e.g. "pr-12" or "sha-abc1234,latest"
variable "TAGS" {
  default = "dev"
}

variable "PLATFORMS" {
  default = "linux/amd64,linux/arm64"
}

# only builds on main write the cache, so PRs can't evict it
variable "CACHE_TO" {
  default = false
}

group "default" {
  targets = ["image"]
}

target "_app" {
  context    = "apps/${APP}"
  dockerfile = "Dockerfile"
  cache-from = ["type=gha,scope=${APP}"]
  cache-to   = CACHE_TO ? ["type=gha,mode=max,scope=${APP}"] : []
}

# optional stage: apps without a `test` stage skip this target
target "test" {
  inherits = ["_app"]
  target   = "test"
  output   = ["type=cacheonly"]
}

target "image" {
  inherits  = ["_app"]
  platforms = split(",", PLATFORMS)
  tags      = [for t in split(",", TAGS) : "${REGISTRY}/${APP}:${t}"]
  labels = {
    "org.opencontainers.image.source" = "https://github.com/pl4nty/homelab"
  }
}
