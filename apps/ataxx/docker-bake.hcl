target "default" {
  # deployed to cluster-1 amd64 nodes; the arm64 build under QEMU exceeds the 6h CI limit
  platforms = ["linux/amd64"]
  contexts = {
    # renovate: branch=main
    src = "https://github.com/pl4nty/ataxx.git#5e4a8c000495a9382be03ced11fad51fb7d47dcc"
  }
}
