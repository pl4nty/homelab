target "default" {
  # Valve only ships steamclient.so for x86_64
  platforms = ["linux/amd64"]
  contexts = {
    # renovate: branch=main
    sdk = "https://github.com/rlabrecque/SteamworksSDK.git#df2baabf574a738ef1ea90a7e89339107fc0a279"
  }
}
