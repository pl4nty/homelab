# msstore-oldversions

Lists and downloads older versions of Microsoft Store (MSIX/APPX) apps. It uses the same
public FE3 (Windows Update delivery) protocol as [StoreLib](https://github.com/StoreDev/StoreLib)
and [StoreWeb](https://github.com/pl4nty/storeweb). It needs only the Python 3.8+ standard library. Download it from the latest `msstore-oldversions/sha-*` [release](https://github.com/pl4nty/homelab/releases).

```sh
python3 msstore_versions.py list 9WZDNCRFHVN5                    # every version FE3 still serves
python3 msstore_versions.py list 9WZDNCRFHVN5 --deps --json      # include frameworks, machine-readable
python3 msstore_versions.py download 9WZDNCRFHVN5 --version 2016.421.20.2000
python3 msstore_versions.py download 9NCBCSZSJRSB --version 1.301.234.0 --arch x64 --url-only
python3 msstore_versions.py list Microsoft.WindowsCalculator_8wekyb3d8bbwe --idtype pfn
```

Downloads are checked against the SHA-256 digest in the FE3 metadata.

## How it works

1. DisplayCatalog `v7.0/products/{id}` → `FulfillmentData.WuCategoryId`
2. FE3 `GetCookie` → anonymous cookie
3. FE3 `SyncUpdates` filtered to that category → one `UpdateInfo` for **each package in the
   product's live package set**, including older versions. Each one has an `UpdateID`,
   a `RevisionNumber`, a `PackageMoniker`, target platforms and file digests.
4. FE3 `GetExtendedUpdateInfo2(UpdateID, RevisionNumber)` → a signed, short-lived
   `tlu.dl.delivery.mp.microsoft.com` URL

## What you can and cannot get (tested 2026-09-30)

| App | Versions returned | Range |
|---|---|---|
| Windows Calculator `9WZDNCRFHVN5` | 36 | 2016.421.20.2000 → 2021.2607.0.0 |
| Snipping Tool `9MZ95KL8MR0L` | 19 | 2018.413.1605.0 → 2022.2607.23.0 |
| Windows Terminal `9N0DX20HK701` | 5 | 3001.12.10982.0 → 3001.24.11911.0 |
| Spotify `9NCBCSZSJRSB` | 4 | 1.192.647.0 → 1.301.234.0 |
| Netflix `9WZDNCRFJ3TJ` | 4 | 6.99.5.0 → 8.53.0.70 |
| WhatsApp `9NKSQGP7F2NH` | 2 | 2.2638.2.0, 2.2638.102.0 |
| Files App `9NGHP3DX8HDX` | 1 | 4.2.9.0 |

- The available set is the set of packages the publisher keeps in the current Store
  submission. Partner Center keeps older packages so that devices on older OS builds,
  or on other device families, can still get an app. It is **not** a full release
  history. For example, Calculator jumps from 2021.2210 to 2021.2307.
- DisplayCatalog's `Packages[]` lists the same set (36 for Calculator, 4 for Spotify).
  FE3 is necessary only to get the signed URL.
- `SyncCurrentVersionOnly` has no effect. You get 36 Calculator packages with `true` or
  `false`.
- FE3 checks identities. If you send a wrong `RevisionNumber` or an unknown `UpdateID`,
  you get no URLs. CDN URLs without the `P1..P4` signature return HTTP 403. Thus you
  cannot guess or forge access to versions that are not in the set.
- Not tested: whether FE3 still signs URLs for an `UpdateID` that has since been
  *removed* from the submission. If it does, archiving `list --json` output on a
  schedule would let you download versions after the Store stops listing them.
  To be safe, archive the files too.
- `.e*` packages (for example `.eappxbundle`, often the `.70` Xbox builds of Microsoft
  apps) are encrypted. You can install them only with a Store licence.
- The anonymous MSA device token in StoreLib is not necessary for public listings. Use
  `--msa-token` for flighted or private listings.
- `platform.target` IDs (0 Universal, 3 Desktop, 4 Mobile, 5 Xbox) are inferred. I got
  them by matching blobs against DisplayCatalog `PlatformDependencies`. Microsoft does
  not document them.

## TLS

FE3 uses a certificate from *Microsoft Update Secure Server CA 2.1*, which chains to
*Microsoft Root Certificate Authority 2011*. That root is not in Mozilla-derived bundles,
so the script embeds it
([source](https://www.microsoft.com/pki/certs/MicRooCerAut2011_2011_03_22.crt)) and adds
it to the default trust store. It does not disable verification.

## Notes for StoreWeb

- StoreLib already returns every package in the set, so `/api/packages` lists older
  versions now.
- `DownloadController` picks the first candidate that has the highest file-type rank. It
  does not pick the highest version. FE3 order is not sorted by version: for Calculator
  the first entry is 2018.906.2224.0. Thus `/api/download` can redirect to an old build.
  I did not run this (there is no .NET SDK here); I found it by reading the code. One fix
  is to sort candidates by `Version` descending before ranking, and to add an optional
  `Version` query parameter.
