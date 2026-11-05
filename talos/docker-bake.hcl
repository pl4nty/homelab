# the RK1 installer, where topf looks for it: <factory>/metal-installer/<schematic ID>:<Talos version>
variable "SCHEMATIC_ID" {}
variable "TALOS_VERSION" {}

target "default" {
  context   = "talos"
  platforms = ["linux/arm64"]
  args = {
    SCHEMATIC_ID  = SCHEMATIC_ID
    TALOS_VERSION = TALOS_VERSION
  }
  tags = ["ghcr.io/pl4nty/talos/metal-installer/${SCHEMATIC_ID}:${TALOS_VERSION}"]
}
