variable "SRC" {
  # renovate: branch=main
  default = "https://github.com/microsoft/MHA.git#7a5250f78ea79162af646b18c1762cd89eae2dbc"
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
