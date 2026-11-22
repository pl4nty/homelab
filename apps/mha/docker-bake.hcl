variable "SRC" {
  # renovate: branch=main
  default = "https://github.com/microsoft/MHA.git#24da86ba1d9635f28d9324736430d2ae5e95844e"
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
