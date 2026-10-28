target "default" {
  # renovate: branch=multi-hostnames-by-annotation
  context = "https://github.com/iamasmith/external-mdns.git#189d07079a1005dfafd92aefaacf6c097e430eb2"
  args = {
    # upstream Dockerfile, not ours to lint
    BUILDKIT_DOCKERFILE_CHECK = "skip=FromAsCasing"
  }
}
