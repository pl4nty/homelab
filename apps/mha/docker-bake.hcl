target "default" {
  contexts = {
    # renovate: branch=main
    src = "https://github.com/microsoft/MHA.git#a00d433443de2281e5d19505fb0ef2375682fd59"
  }
  args = {
    # webpack.config.js reads the commit SHA with git rev-parse
    BUILDKIT_CONTEXT_KEEP_GIT_DIR = "1"
  }
}
