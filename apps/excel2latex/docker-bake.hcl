target "default" {
  # renovate: branch=master
  context = "https://github.com/pl4nty/excel2latex.git#ebbe06b9911bb05431079e07c14617e5b79bdf8e"
  args = {
    # upstream Dockerfile, not ours to lint
    BUILDKIT_DOCKERFILE_CHECK = "skip=FromAsCasing"
  }
}
