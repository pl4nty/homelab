variable "SRC" {
  # renovate: branch=main
  default = "https://github.com/microsoft/MHA.git#be418550716789771e312196677bdd0b0a2915ca"
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
