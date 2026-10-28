# winget-proxy

One service hosting four [WinGet REST sources](https://github.com/microsoft/winget-cli-restsource), each
under its own path prefix, sharing the protocol implementation in `WinGet.RestSource.Shared`:

| Prefix | Source | Serves | For |
| --- | --- | --- | --- |
| `/xbox` | `XboxStore` | Xbox store games the built-in `msstore` source does not index | [winget-cli#5818](https://github.com/microsoft/winget-cli/issues/5818) |
| `/features` | `WindowsFeatures` | Windows optional features and capabilities (Telnet, Hyper-V, WSL, RSAT, OpenSSH…) | [winget-cli#5986](https://github.com/microsoft/winget-cli/issues/5986) |
| `/updatecatalog` | `WindowsUpdateCatalog` | Patches and drivers from the Microsoft Update Catalog | [winget-cli#5332](https://github.com/microsoft/winget-cli/issues/5332) |
| `/msstore-versioned` | `StoreVersions` | Older versions of Store MSIX/APPX apps, which `msstore` cannot install | |

Each prefix answers the full protocol — `GET /information`, `POST /manifestSearch`,
`GET /packageManifests/{PackageIdentifier}` — so each is added to WinGet as its own source:

```powershell
winget source add --name xbox              --arg https://your-host/xbox              --type Microsoft.Rest
winget source add --name features          --arg https://your-host/features          --type Microsoft.Rest
winget source add --name updatecatalog     --arg https://your-host/updatecatalog     --type Microsoft.Rest
winget source add --name msstore-versioned --arg https://your-host/msstore-versioned --type Microsoft.Rest

winget search roblox --source xbox
winget install Microsoft.Windows.Feature.TelnetClient --source features
winget install 84d8dd32-6250-435c-8884-133c1daa4464 --source updatecatalog  # a catalog update GUID
winget install 9WZDNCRFHVN5 --source msstore-versioned --version 2021.2607.0.0  # a Store product ID
```

The URL **must** be `https://` — WinGet's `RestSourceFactory` rejects plain HTTP (loopback with a trusted
dev certificate is fine). [pinget](https://github.com/Devolutions/pinget) speaks the same protocol, accepts
HTTP, and makes a quicker local loop.

## How each source works

**Xbox** (`src/WinGet.RestSource/Xbox/`) — queries the public Store display catalog (autosuggest + product
details), restricted to the Games product family, and the storefront service to keep only titles the Store
will install on a PC (console-only titles are excluded; the display catalog alone cannot tell them apart).
Manifests carry one `msstore` installer with `MSStoreProductIdentifier`, so installation is handed to the
Store client exactly as the `msstore` source does.

**Features** (`src/WinGet.RestSource/Features/`) — serves the curated catalog in `Features/catalog.json` of
DISM optional features and capabilities, as `Microsoft.Windows.Feature.<Name>` /
`Microsoft.Windows.Capability.<Name>`. The catalog is static because features live on the client: there is
no server to enumerate them from, DISM names are stable, and DISM rejects entries a build does not carry.
Capability names keep their `~~~~` version suffix, which becomes the package version. An empty query or
`FetchAllManifests` returns the whole catalog, so `winget export` works.

**Updates** (`src/WinGet.RestSource/Updates/`) — scrapes the same three pages the Update Catalog website
uses: the search table, the download dialog (which carries direct file URLs *and their SHA-256 digests*),
and the details view. Package identifiers are the catalog's update GUIDs; the catalog resolves a GUID
search to its single row, which is what serves `winget install --id`. One installer is emitted per file,
with the architecture parsed from the file name.

**Versions** (`src/WinGet.RestSource/Versions/`) — speaks FE3, the Windows Update delivery protocol the Store
client uses (as do [StoreLib](https://github.com/StoreDev/StoreLib) and [StoreWeb](https://github.com/pl4nty/storeweb)).
The display catalog gives a product's `WuCategoryId`; a `SyncUpdates` filtered to it returns every package in
the product's live package set, older versions included; `GetExtendedUpdateInfo2` signs a download URL for each.
Package identifiers are Store product IDs. Manifests carry one `msix`/`appx` installer per architecture, with the
package's SHA-256 from the FE3 metadata. The signed URLs expire within minutes, so they are fetched for every
manifest request; the package lists are cached. They are plain HTTP (the CDN host has no certificate for its
name), which the SHA-256 check covers.

What FE3 serves (tested 2026-10-28): the packages the publisher keeps in the current submission, for older OS
builds and other device families — not a full release history. Calculator `9WZDNCRFHVN5` has 26 versions,
Windows Terminal `9N0DX20HK701` 6, Spotify `9NCBCSZSJRSB` 4. Encrypted packages (`.eappx`, `.emsixbundle`, often
Xbox builds) need a Store licence and are left out, as are Win32 listings, which have no `WuCategoryId`. FE3
uses a certificate chained to *Microsoft Root Certificate Authority 2011*, which isn't in Mozilla-derived
trust stores, so the FE3 client trusts that root alone.

## The shim installers

WinGet has no `dism`, `msu` or `cab` installer type, so the features and updates manifests point at a small
Windows executable the service hosts under the source's own prefix (`/features/shim.exe`,
`/updatecatalog/shim.exe`), with the real work encoded in `InstallerSwitches.Custom`:

```
winget-feature-shim.exe /action:enable /kind:Feature /name:TelnetClient
→ dism.exe /online /enable-feature /featurename:TelnetClient /all /norestart /quiet

winget-update-shim.exe /type:msu /url:https://catalog.s.download.windowsupdate.com/... /sha256:<base64>
→ downloads, verifies, then wusa.exe <file> /quiet /norestart
```

The updates shim hands `.msu` to `wusa`, driver `.cab` to `expand` + `pnputil /add-driver`, and other
`.cab` to `dism /online /add-package`. The chain stays verifiable end to end: WinGet checks the downloaded
shim against the manifest's `InstallerSha256` (computed from the exact bytes the service serves), and the
updates shim checks the payload against the catalog's published SHA-256 — refusing to install on mismatch,
and only accepting payload URLs on `*.windowsupdate.com` / `*.microsoft.com`. Manifests declare
`elevationRequired` and map exit code 3010 to `rebootRequiredToFinish`.

The feature shim also registers an Apps & Features entry matching the manifest's `ProductCode`
(`WinGetFeature.<Kind>.<Name>`) with an uninstall string that disables the feature again — so
`winget list` shows enabled features and `winget uninstall` works.

## Run it

```console
docker run --rm -p 8080:8080 ghcr.io/pl4nty/winget-proxy
```

From source, first cross-compile the shims (works on any OS), then run:

```console
dotnet publish src/WinGet.Features.Shim -c Release
dotnet publish src/WinGet.Updates.Shim -c Release
mkdir -p src/WinGet.RestSource/shim
cp src/WinGet.Features.Shim/bin/Release/net9.0-windows/win-x64/publish/winget-feature-shim.exe \
   src/WinGet.Updates.Shim/bin/Release/net9.0/win-x64/publish/winget-update-shim.exe \
   src/WinGet.RestSource/shim/
dotnet run --project src/WinGet.RestSource
```

Without a shim in place its source still answers searches but returns no manifests, since installers need
the shim's URL and hash. The Xbox source needs no shim.

| Setting | Default | Meaning |
| --- | --- | --- |
| `RestSource:PublicBaseUrl` | request URL | External base URL written into installer URLs |
| `XboxSource:DefaultMarket` | `US` | Storefront used when the client does not send a market |
| `XboxSource:Language` | `en-us` | Language for titles and descriptions |
| `XboxSource:DeviceFamily` | `Windows.Desktop` | Device a title must be installable on; `Windows.Xbox` serves console titles |
| `XboxSource:MaximumResults` | `25` | Cap on Xbox search results |
| `XboxSource:CacheDuration` | `00:15:00` | Store response cache lifetime |
| `FeaturesSource:ShimPath` | `shim/winget-feature-shim.exe` | DISM shim, relative to the content root |
| `FeaturesSource:CatalogPath` | `Features/catalog.json` | Feature catalog, relative to the content root |
| `FeaturesSource:MaximumResults` | `100` | Cap on feature search results |
| `UpdatesSource:ShimPath` | `shim/winget-update-shim.exe` | Update shim, relative to the content root |
| `UpdatesSource:MaximumResults` | `25` | Cap on update search results |
| `UpdatesSource:CacheDuration` | `01:00:00` | Update Catalog response cache lifetime |

## Test it

`dotnet test tests/WinGet.RestSource.Tests` covers all three sources' endpoints — the Store and Update
Catalog replaced by canned pages trimmed from real responses, the shims by stand-ins — no network, no
Windows. The shims themselves only truly run on Windows (DISM, wusa, pnputil, registry), so exercise
`winget install` end to end on a Windows machine or VM.

## Limitations

* **Xbox**: the catalog does not version games, so manifests report `Unknown` and upgrades cannot be
  detected; search is backed by autosuggest (~10 candidates per query); `FetchAllManifests` would mean
  enumerating the whole store and is not supported.
* **Features**: applicability is client-side only (a Home SKU lists Hyper-V but DISM refuses it there);
  the catalog is curated, not exhaustive — additions are one JSON entry; features enabled outside WinGet
  are not correlated by `winget list`.
* **Updates**: most patches have no catalog version, so `winget upgrade` cannot offer them — detecting
  what a machine needs remains Windows Update's job; self-extracting `.exe` payloads are searchable but
  not installable; checkpoint cumulative updates may need the checkpoint installed first; only the
  catalog's first results page (25 rows) is searched; drivers are matched by text, not hardware IDs;
  installed updates are not tracked by `winget list`.
