target "default" {
  contexts = {
    # v2.1.6. No renovate comment, because it only tracks branches: bump this and the image in the Dockerfile together
    src = "https://github.com/otter-sec/rctf.git#364dc3bc223884e1c9c483bf81c5909333bb2738"
  }
}
