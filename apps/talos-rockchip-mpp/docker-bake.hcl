target "default" {
  dockerfile = "Pkgfile"
  target     = "rockchip-mpp"
  platforms  = ["linux/arm64"]
  # as siderolabs/extensions, which builds with --provenance=false
  attest = ["type=provenance,disabled=true"]
  # siderolabs/extensions v1.14.5
  args = {
    ABBREV_TAG   = "v1.14.5"
    PKGS         = "v1.14.0-48-gf4bda77"
    PKGS_PREFIX  = "ghcr.io/siderolabs"
    TOOLS        = "v1.14.0-11-g8dad45e"
    TOOLS_PREFIX = "ghcr.io/siderolabs"
  }
}
