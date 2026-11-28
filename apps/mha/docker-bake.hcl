variable "SRC" {
  # renovate: branch=main
  default = "https://github.com/microsoft/MHA.git#e1a609905554bfcb7a518ae95757776d801c6050"
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
