target "default" {
  platforms = ["linux/amd64"]
  output    = ["type=image", "type=local,dest=dist,platform-split=false"]
}
