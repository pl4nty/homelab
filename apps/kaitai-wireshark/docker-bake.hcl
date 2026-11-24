target "default" {
  # the image holds only the generated dissectors, which don't depend on the platform
  platforms = ["linux/amd64"]
  output    = ["type=image", "type=local,dest=dist,platform-split=false"]
}
