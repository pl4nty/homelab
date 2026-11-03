# ipa-web

Search App Store apps and view metadata from their `.ipa` files: URL schemes, Universal Links, `Info.plist`, `entitlements.plist` and `PrivacyInfo.xcprivacy`. Replaces [ipa-web](https://github.com/pl4nty/ipa-web) and [ipa-track](https://github.com/pl4nty/ipa-track).

Opening `/bundle/<bundle ID>` checks the App Store version at most once per `CACHE_TTL` (default 24h). A new version is purchased (free apps only), downloaded with [ipatool](https://github.com/majd/ipatool) and extracted to `DATA_DIR`. Every extracted version is kept, so past versions stay selectable.

| Env | Purpose |
| --- | --- |
| `EMAIL`, `PASSWORD` | Apple account without 2FA |
| `MAC_ADDRESS` | Store hardware identity, kept stable across pod restarts |
| `DATA_DIR` | Extracted versions and session cookies |
| `XDG_CACHE_HOME` | ipatool's Apple/Unicorn runtime assets (~150MB) |
