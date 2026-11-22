# do-peer

A Delivery Optimization (DO) peer: it seeds every file in a folder over DO's peer protocol (TCP 7680), serves each
file and its pieces hash file over HTTP, and can advertise itself on the LAN with DNS-SD the way Windows does.

```sh
Content=/srv/files dotnet run --project src/DoPeer             # HTTP on 8080, peers on 7680
Content=/srv/files DnsSd=true dotnet run --project src/DoPeer  # also answer mDNS for _dosvc._tcp.local
dotnet run --project src/DoPeer -- fetch 192.0.2.10:7680 https://host/pieceshash/file.bin out.bin
dotnet run --project src/DoPeer -- encrypt file.bin file.enc   # prints the DecryptionInfo JSON
```

| Setting | Default | |
| --- | --- | --- |
| `Content` | `/content` | Folder to share. `POST /rescan` picks up new files. |
| `PeerPort` | `7680` | DO's port. |
| `DnsSd` | `false` | Advertise over mDNS. Needs the host network, since multicast doesn't leave a pod network. |
| `AdvertiseAddress` | every up IPv4 | The A record to advertise. |

`GET /` lists each file with its `ContentId`, swarm hash, URLs and the `IntegrityCheckInfo` JSON for the DO API.
`GET /files/{name}` serves the file with ranges, and `GET /pieceshash/{name}` its pieces hash file.

## Protocol

From `doclient.dll` 10.0.26100.6, decompiled with its public PDB. The function names are from the PDB.

- **Pieces hash file**: JSON with `MajorVersion` 1, `MinorVersion` 0, `HashOfHashes`, `ContentLength`,
  `PieceSize` (1 MiB; `CMetaInfo::CreateFromBuf` rejects more) and `Pieces`, the SHA256 of each piece in base64.
  `HashOfHashes` is the SHA256 of the two versions (u16), the length (u64) and the piece size (u32), little-endian,
  then every piece hash (`CMetaInfo::_CheckHashes`). The tests check this against a pieces hash file from
  `dl.delivery.mp.microsoft.com`.
- **Swarm hash**: the 32-byte `HashOfHashes`. Without a pieces hash file, the client parses a 64-character hex
  ContentId as the swarm hash, or picks a random one (`CCore::_PopulateSwarmStartData`).
- **ContentId**: the content policy service answers `DO-` and the base64 `HashOfHashes`, with `+` as `_` and `/` as
  `-` (seen on KB5132061 and KB5043080).
- **Handshake** (`CPeerSock::SendHandShake`): length 14, `Swarm protocol`, 8 reserved bytes (byte 0 the protocol
  version, 1; byte 5 is `0x10`), the swarm hash and a 20-byte peer ID. The receiver reads the hash before it
  answers, then reads the peer ID (`CPeerSock::_ProcessBytes`). A swarm it doesn't seed gets the connection closed.
- **Messages** (`CPeerSock::_ProcessMsg`): a 4-byte big-endian length (at most `0x1f4000`), then BitTorrent's
  message IDs: 0 choke, 1 unchoke, 2 interested, 3 not interested, 4 have, 5 bitfield (piece 0 is the high bit), 6
  request, 7 piece, 8 cancel, plus 10 DoNotHave (version 1 and up). The client skips ID 20 (extended).
- **DNS-SD** (`CDnsPeerRegistrar`, `CDnsPeerSearcher`): instance `<host>._dosvc._tcp.local`, the peer port, and TXT
  `SH00`, `SH01`… with the first 16 base64 characters of each swarm hash, `P` the device profile and `G` the group
  ID. The searcher skips records without `P`, a profile it treats as incompatible, or a different `G`. This peer
  sends `P=0` and no `G`.
- **DecryptionInfo** (`CBackgroundCopyFile::_SetDecryptionInfo`, `CCipher`): JSON with `KeyData` (base64),
  `AlgorithmName` and `ChainingMode` (default AES-CBC) and `EncryptionBufferSize` (default 64 KiB, at most 1 MiB).
  Each buffer is decrypted on its own, with the IV set to AES-ECB of its offset (u64 little-endian, then zeros).
  The last buffer is tried with PKCS7 padding, then without. Peers carry the ciphertext. `DoCipher` writes this
  format.
- **IntegrityCheckMandatory**: without it, a missing or bad caller pieces hash file falls back to an unchecked
  download. With it, the download fails (`0x80D02016`, `0x80D02017`).

[protocol/](protocol) has a Kaitai Struct description of the peer protocol and a Wireshark dissector generated from
it. Wireshark also has its own `MS-DO` dissector on TCP 7680.

## What works and what isn't verified

- Verified: the HashOfHashes formula, and `fetch` against this server, which downloads every piece and checks it.
  The tests cover both, plus the handshake layout, a bad block request and the DNS-SD answer.
- Not verified: a Windows device downloading from this peer. That needs a Windows test machine.
- The DO arrays return `FailureReason 0x0001` for a ContentId the DO services don't know (tried 2026-11-22), so this
  peer can't announce its own files to the cloud. Windows finds it only over DNS-SD, or as a peer for Microsoft
  content it holds a byte-identical copy of.
- Windows checks each piece against a pieces hash file. For a file of its own, a DO API caller sets
  `DODownloadProperty_IntegrityCheckInfo` to the JSON from `GET /` (`CBackgroundCopyFile::_SetPhfInfo` reads
  `PiecesHashFileUrl`, `HashOfHashes`, `PiecesHashFileDigest` and `PiecesHashFileDigestAlgorithm`). The client
  also checks the URL host and the caller against allow lists (`CGlobalConfigManager::IsRegisteredCaller`), so
  whether it uses peers for a homelab URL isn't known.
