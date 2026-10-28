target "default" {
  dockerfile = "Pkgfile"
  target     = "rockchip-mpp"
  platforms  = ["linux/arm64"]
  # as siderolabs/extensions, which builds with --provenance=false
  attest = ["type=provenance,disabled=true"]
  # siderolabs/extensions v1.14.4
  args = {
    ABBREV_TAG   = "v1.14.4"
    PKGS         = "v1.14.0-44-g2ec10eb"
    PKGS_PREFIX  = "ghcr.io/siderolabs"
    TOOLS        = "v1.14.0-9-g6b71647"
    TOOLS_PREFIX = "ghcr.io/siderolabs"
  }
}
