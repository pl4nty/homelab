variable "SRC" {
  # renovate: branch=main
  default = "https://github.com/microsoft/MHA.git#a00d433443de2281e5d19505fb0ef2375682fd59"
}

target "default" {
  contexts = {
    src = SRC
  }
  args = {
    # webpack.config.js needs the commit SHA, and the git context has no .git dir
    SCM_COMMIT_ID = element(split("#", SRC), 1)
  }
}
