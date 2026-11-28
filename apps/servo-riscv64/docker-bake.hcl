target "default" {
  contexts = {
    # renovate: branch=main
    src = "https://github.com/servo/servo.git#aa297ce51cdc6ae07d3027aa15f78805ea8ad17c"
  }
  # cross-compiled on the build platform, so the image holds a riscv64 binary
  platforms = ["linux/riscv64"]
  output    = ["type=image", "type=local,dest=dist,platform-split=false"]
}
