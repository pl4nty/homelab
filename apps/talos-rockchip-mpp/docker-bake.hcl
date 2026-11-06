variable "ABBREV_TAG" {
  default = "v1.14.5"
}

target "default" {
  dockerfile = "Pkgfile"
  target     = "rockchip-mpp"
  platforms  = ["linux/arm64"]
  # as siderolabs/extensions, which builds with --provenance=false
  attest = ["type=provenance,disabled=true"]
  # the modules only load on this Talos version, so talos/hardware/rk1-schematic.yaml pins it like Sidero's extensions
  tags = ["ghcr.io/pl4nty/${APP}:${TAG}", "ghcr.io/pl4nty/${APP}:${ABBREV_TAG}"]
  # siderolabs/extensions v1.14.5
  args = {
    ABBREV_TAG   = ABBREV_TAG
    PKGS         = "v1.14.0-48-gf4bda77"
    PKGS_PREFIX  = "ghcr.io/siderolabs"
    TOOLS        = "v1.14.0-11-g8dad45e"
    TOOLS_PREFIX = "ghcr.io/siderolabs"
  }
}
