variable "SRC" {
  # renovate: branch=main
  default = "https://github.com/vegu-ai/talemate.git#7db12b042b6200d6a91145ae7c833af1b7e9fc9e"
}

# upstream moved to uv with CUDA torch and keeps its own Dockerfile, so build that instead of a fork of it
target "default" {
  context    = SRC
  dockerfile = "Dockerfile"
  # the final stage downloads an x86_64-only FFmpeg build
  platforms = ["linux/amd64"]
  args = {
    # upstream's Dockerfile appends to unset LD_LIBRARY_PATH and PYTHONPATH, which the CI check step rejects
    BUILDKIT_DOCKERFILE_CHECK = "skip=UndefinedVar"
  }
}
