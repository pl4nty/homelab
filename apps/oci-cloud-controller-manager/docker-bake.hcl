target "default" {
  contexts = {
    # v1.36.0. No renovate comment, because it only tracks branches: bump this and the version below together
    src = "https://github.com/oracle/oci-cloud-controller-manager.git#93969b53c3a17ea558b98ed31605cf69de9f37a5"
  }
  args = {
    VERSION = "v1.36.0-patched"
  }
}
