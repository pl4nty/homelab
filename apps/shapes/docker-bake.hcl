target "default" {
  # deployed to cluster-1 amd64 nodes; the arm64 build under QEMU exceeds the 6h CI limit
  platforms = ["linux/amd64"]
  contexts = {
    # renovate: branch=main
    src = "https://github.com/pl4nty/shapes.git#271ce4a9929c2c69eb5cbaf039169012370bdd34"
  }
}
