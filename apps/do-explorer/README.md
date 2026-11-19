# do-explorer

Explore Delivery Optimization (DO): pick a file from the Microsoft Store, the Microsoft Update Catalog or a URL,
then call the DO services for its content policy, array and peer list, the way a Windows client does.

Run it with `NODE_EXTRA_CA_CERTS=ms-roots.pem bun src/server.ts`. Bun has no dependencies to install.

## Content sources

- **Microsoft Store**: `storeedgefd.dsx.mp.microsoft.com/v9.0/packageManifests/{id}` (the `msstore` WinGet source)
  lists installer URLs and SHA256s for Win32 apps. For MSIX apps it lists only the product ID, so the display
  catalog gives the `WuCategoryId`, and FE3 lists the packages and signs a URL for one. FE3 is ported from
  `winget-proxy`'s `StoreDelivery.cs`.
- **Update Catalog**: the search and download dialog pages, ported from `winget-proxy`'s `UpdateCatalog.cs`.
- **URL or ContentId**: anything else.

## DO calls

Each step follows `doclient.dll` 10.0.26100.6 (decompiled with its public PDB), and each was checked against
the live services on 2026-11-19.

1. `geo.prod.do.dsp.mp.microsoft.com/geo` gives the country and the key-value (KV) endpoint; KV `/all` gives the
   service config.
2. **Content policy** `cp801…/content/{contentId}/contentpolicy?altCatalogId={url}`. `altCatalogId` is the download
   URL with its query stripped. Without a caller ContentId, the client's `{contentId}` is the SHA1 of that URL,
   hex encoded (`CBackgroundCopyJob::_InternalCreateDownload`). The service looks the file up by `altCatalogId` and
   returns its own `ContentId`, `DO-<base64url(HashOfHashes)>`, where `HashOfHashes` is from the file's
   `pieceshash`. Without `altCatalogId`, it returns `{}` for every ID except one it already knows.
3. **Discovery** `disc801…/content/{ContentId}?partitionId={n}&altCatalogId={url}` returns the array (a
   `CollectiveArray` URL). The client sends `partitionId = clientHash % Discovery_MaxPartitionId` (21).
   Unknown content returns 404.
4. **Join** `POST {array}join/` with the JSON from `CAnnounceInfo::ToJson` returns `Peers`. The array answers
   `FailureReason 0x0001` without `ClientDialectVersion*` (10.1.0.13, from `CSwarm::GetAnnounceInfo`) or when the
   `AltCatalogId` differs from the one discovery used. `Scope` follows `CAnnounceInfo::SetScopeAndGroupId`: 1 for
   Internet, 2 for LAN, 6 for Group. The explorer announces a peer that is still downloading, with restricted
   upload, then sends `JoinRequestEvent 2`, which the client sends when a swarm stops. The array answers that with
   no peers; that it removes the peer is inferred, not verified.

Filestreamingservice files (FE3 and the Update Catalog) are keyed by the `tlu.dl.delivery.mp.microsoft.com` URL
that FE3 hands out. The same file as a `dl.` URL gets `FailureReason 0x0001` from the array, and as a
`catalog.sf.` URL an empty content policy, so the explorer rewrites these URLs to the `tlu.` form.

For example, the 2026-11 Windows 11 24H2 x64 cumulative update (KB5132061, `DO-` ID from the content policy) and
Windows Calculator 2021.2607.0.0 (SHA1 ID) each returned 50 Internet peers, as many as the announce asks for with
`PeersWanted 50`.

## Limits

- Peers come back only for content clients fetch through DO. The client checks the URL host against an allow list
  and the caller against a registered list (`CGlobalConfigManager::IsRegisteredCaller`). WinGet sends the
  installer SHA256 as ContentId, but `github.com` and most installer hosts are not on the list, so these return 404.
- Some Store packages return no peers, for example Windows Terminal 3001.24.12741.0. Why is not known.
- The DO services chain to the Microsoft ECC Product Root Certificate Authority 2018, and FE3 to the Microsoft
  Root Certificate Authority 2011. Bun's bundled roots have neither (the calls fail without them), so
  `ms-roots.pem` carries both.
- Peer lists carry other devices' public IP addresses, so the route is on the private domain.
