target "default" {
  # the script runs anywhere, and two platforms would export the same file twice
  platforms = ["linux/amd64"]
  output    = ["type=image", "type=local,dest=dist,platform-split=false"]
}
