#!/usr/bin/env python3
"""List and download current and previous versions of Microsoft Store (MSIX/APPX) apps.

Uses the same public endpoints as StoreLib (https://github.com/StoreDev/StoreLib):

1. DisplayCatalog  -> product's WuCategoryId
2. FE3 GetCookie   -> anonymous session cookie
3. FE3 SyncUpdates -> every package revision the Store still publishes for that
                      category (StoreLib's request already sets
                      SyncCurrentVersionOnly=false, so older versions are included)
4. FE3 GetExtendedUpdateInfo2 -> signed CDN URL for one UpdateID/RevisionNumber

Standard library only. Python 3.8+.
"""

import argparse
import base64
import hashlib
import html
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from xml.etree import ElementTree as ET

DCAT = "https://displaycatalog.mp.microsoft.com/v7.0/products/"
FE3 = "https://fe3.delivery.mp.microsoft.com/ClientWebService/client.asmx"
FE3_SECURED = FE3 + "/secured"
NS = {"w": "http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService"}

# FE3 serves a certificate from "Microsoft Update Secure Server CA 2.1", which chains
# to this root. The root is not in Mozilla-derived CA bundles, so it is added to the
# default trust store instead of disabling verification.
# Source: https://www.microsoft.com/pki/certs/MicRooCerAut2011_2011_03_22.crt
# SHA-256: 84:7D:F6:A7:84:97:94:3F:27:FC:72:EB:93:F9:A6:37:32:0A:02:B5:61:D0:A9:1B:09:E8:7A:78:07:ED:7C:61
MS_ROOT_2011 = """-----BEGIN CERTIFICATE-----
MIIF7TCCA9WgAwIBAgIQP4vItfyfspZDtWnWbELhRDANBgkqhkiG9w0BAQsFADCB
iDELMAkGA1UEBhMCVVMxEzARBgNVBAgTCldhc2hpbmd0b24xEDAOBgNVBAcTB1Jl
ZG1vbmQxHjAcBgNVBAoTFU1pY3Jvc29mdCBDb3Jwb3JhdGlvbjEyMDAGA1UEAxMp
TWljcm9zb2Z0IFJvb3QgQ2VydGlmaWNhdGUgQXV0aG9yaXR5IDIwMTEwHhcNMTEw
MzIyMjIwNTI4WhcNMzYwMzIyMjIxMzA0WjCBiDELMAkGA1UEBhMCVVMxEzARBgNV
BAgTCldhc2hpbmd0b24xEDAOBgNVBAcTB1JlZG1vbmQxHjAcBgNVBAoTFU1pY3Jv
c29mdCBDb3Jwb3JhdGlvbjEyMDAGA1UEAxMpTWljcm9zb2Z0IFJvb3QgQ2VydGlm
aWNhdGUgQXV0aG9yaXR5IDIwMTEwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIK
AoICAQCygEGqNThNE3IyaCJNuLLx/9VSvGzH9dJKjDbu0cJcfoyKrq8TKG/Ac+M6
ztAlqFo6be+ouFmrEyNozQwph9FvgFyPRH9dkAFSWKxRxV8qh9zc2AodwQO5e7BW
6KPeZGHCnvjzfLnsDbVU/ky2ZU+I8JxImQxCCwl8MVkXeQZ4KI2JOkwDJb5xalwL
54RgpJki49KvhKSn+9GY7Qyp3pSJ4Q6g3MDOmT3qCFK7VnnkH4S6Hri0xElcTzFL
h93dBWcmmYDgcRGjuKVB4qRTufcyKYMME782XgSzS0NHL2vikR7TmE/dQgfI6B0S
/Jmpaz6SfsjWaTr8ZL22CZ3K/QwLopt3YEsDlKQwaRLWQi3BQUzK3Kr9j1uDRprZ
/LHR47PJf0h6zSTwQY9cdNCssBAgBkm3xy0hyFfj0IbzA2j70M5xwYmZSmQBbP3s
MJHPQTySx+W6hh1hhMdfgzlirrSSL0fzC/hV66AfWdC7dJse0Hbm8ukG1xDo+mTe
acY1logC8Ea4PyeZb8txiSk190gWAjWP1Xl8TQLPX+uKg09FcYj5qQ1OcunCnAfP
SRtOBA5jUYxe2ADBVSy2xuDCZU7JNDn1nLPEfuhhbhNfFcRf2X7tHc7uROzLLoax
7Dj2cO2rXBPB2Q8Nx4CyVe0096yb5MPa50c8prWPMd/FS6/r8QIDAQABo1EwTzAL
BgNVHQ8EBAMCAYYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUci06AjGQQ7kU
BU7h6qfHMdEjiTQwEAYJKwYBBAGCNxUBBAMCAQAwDQYJKoZIhvcNAQELBQADggIB
AH9yzw+3xRXbm8BJyiZb/p4T5tPw0tuXX/JLP02zrhmu7deXoKzvqTqjwkGw5biR
nhOBJAPmCf0/V0A5ISRW0RAvS0CpNoZLtFNXmvvxfomPEf4YbFGq6O0JlbXlccmh
6Yd1phV/yX43VF50k8XDZ8wNT2uoFwxtCJJ+i92Bqi1wIcM9BhS7vyRep4TXPw8h
Ir1LAAbblxzYXtTFC1yHblCk6MM4pPvLLMWSZpuFXst6bJN8gClYW1e1QGm6CHmm
ZGIVnYeWRbVmIyADixxzoNOieTPgUFmG2y/lAiXqcyqfABTINseSO+lOAOzYVgm5
M0kS0lQLAausR7aRKX1MtHWAUgHoyoL2n8ysnI8X6i8msKtyrAv+nlEex0NVZ09R
s1fWtuzuUrc66U7h14GIvE+OdbtLqPA1qibUZ2dJsnBMO5PcHd94kIZysjik0dyS
TclY6ysSXNQ7roxrsIPlAT/4CTL2kzU0Iq/dNw13CYArzUgA8YyZGUcFAenRv9FO
0OYoQzeZpApKCNmacXPSqs0xE2N2oTdvkjgefRI8ZjLny23h/FKJ3crWZgWalmG+
oijHHKOnNlA8OqTfSm7mhzvO6/DggTedEzxSjr25HTTGHdUKaj2YKXCMiSrRq4IQ
SB/c9O+lxbtVGjhjhE63bK2VVOxlIhBJF7jAHscPrFRH
-----END CERTIFICATE-----"""

# Detectoid/category UpdateIDs that the client claims are installed. FE3 returns no
# app packages when this list is empty. Copied from StoreLib's WUIDRequest.xml.
INSTALLED_NON_LEAF_UPDATE_IDS = [
    1, 2, 3, 11, 19, 544, 549, 2359974,
    2359977, 5169044, 8788830, 23110993, 23110994, 54341900, 54343656, 59830006,
    59830007, 59830008, 60484010, 62450018, 62450019, 62450020, 66027979, 66053150,
    97657898, 98822896, 98959022, 98959023, 98959024, 98959025, 98959026, 104433538,
    104900364, 105489019, 117765322, 129905029, 130040031, 132387090, 132393049, 133399034,
    138537048, 140377312, 143747671, 158941041, 158941042, 158941043, 158941044, 159123858,
    159130928, 164836897, 164847386, 164848327, 164852241, 164852246, 164852252, 164852253,
]

DEVICE_ATTRIBUTES = (
    "BranchReadinessLevel=CB;CurrentBranch=rs_prerelease;OEMModel=Virtual Machine;"
    "FlightRing=WIS;AttrDataVer=21;SystemManufacturer=Microsoft Corporation;"
    "InstallLanguage=en-US;OSUILocale=en-US;InstallationType=Client;"
    "FlightingBranchName=external;FirmwareVersion=Hyper-V UEFI Release v2.5;"
    "SystemProductName=Virtual Machine;OSSkuId=48;FlightContent=Branch;App=WU;"
    "OEMName_Uncleaned=Microsoft Corporation;AppVer=10.0.16184.1001;OSArchitecture=AMD64;"
    "SystemSKU=None;UpdateManagementGroup=2;IsFlightingEnabled=1;IsDeviceRetailDemo=0;"
    "TelemetryLevel=3;OSVersion=10.0.16184.1001;DeviceFamily=Windows.Desktop;"
)

# ApplicabilityBlob platform.target values. Inferred by matching blobs against the
# PlatformDependencies that DisplayCatalog lists for the same packages; not documented.
PLATFORMS = {0: "Windows.Universal", 3: "Windows.Desktop", 4: "Windows.Mobile", 5: "Windows.Xbox"}


def _ssl_context():
    ctx = ssl.create_default_context()
    ctx.load_verify_locations(cadata=MS_ROOT_2011)
    return ctx


_CTX = _ssl_context()


def http(url, body=None, headers=None, method=None, attempts=3):
    req = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
    for i in range(attempts):
        try:
            return urllib.request.urlopen(req, context=_CTX, timeout=60)
        except urllib.error.HTTPError:
            raise
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            if i == attempts - 1:
                raise
            time.sleep(2 ** i)


def soap(url, action, body_xml, auth_xml=""):
    now = datetime.now(timezone.utc)
    ts = lambda d: d.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    envelope = f"""<s:Envelope xmlns:a="http://www.w3.org/2005/08/addressing" xmlns:s="http://www.w3.org/2003/05/soap-envelope">
<s:Header>
<a:Action s:mustUnderstand="1">http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService/{action}</a:Action>
<a:MessageID>urn:uuid:{uuid.uuid4()}</a:MessageID>
<a:To s:mustUnderstand="1">{url}</a:To>
<o:Security s:mustUnderstand="1" xmlns:o="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
<Timestamp xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"><Created>{ts(now)}</Created><Expires>{ts(now + timedelta(minutes=5))}</Expires></Timestamp>
<wuws:WindowsUpdateTicketsToken wsu:id="ClientMSA" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd" xmlns:wuws="http://schemas.microsoft.com/msus/2014/10/WindowsUpdateAuthorization">
<TicketType Name="MSA" Version="1.0" Policy="MBI_SSL">{auth_xml}</TicketType>
</wuws:WindowsUpdateTicketsToken>
</o:Security>
</s:Header>
<s:Body>{body_xml}</s:Body>
</s:Envelope>"""
    with http(url, envelope.encode(), {"Content-Type": "application/soap+xml; charset=utf-8"}) as r:
        return ET.fromstring(r.read())


def dcat_lookup(ident, idtype, market, lang):
    loc = f"market={market}&languages={lang}-{market},{lang},neutral"
    if idtype == "productid":
        url = f"{DCAT}{urllib.parse.quote(ident)}?{loc}&fieldsTemplate=Details"
    else:
        alt = {"pfn": "PackageFamilyName", "cid": "CONTENTID", "xti": "XboxTitleID"}[idtype]
        url = f"{DCAT}lookup?alternateId={alt}&Value={urllib.parse.quote(ident)}&{loc}&fieldsTemplate=Details"
    with http(url) as r:
        data = json.load(r)
    product = data.get("Product") or (data.get("Products") or [None])[0]
    if not product:
        sys.exit(f"Product not found in DisplayCatalog: {ident}")
    sku = product["DisplaySkuAvailabilities"][0]["Sku"]["Properties"]
    fd = sku.get("FulfillmentData")
    if isinstance(fd, str):
        fd = json.loads(fd)
    if not fd or not fd.get("WuCategoryId"):
        sys.exit("Product has no WuCategoryId. It is probably not an MSIX/APPX app "
                 "(e.g. a Win32 installer listing), so FE3 cannot serve it.")
    title = product["LocalizedProperties"][0].get("ProductTitle", "")
    pfn = (sku.get("Packages") or [{}])[0].get("PackageFamilyName") or fd.get("PackageFamilyName")
    return title, fd["WuCategoryId"], pfn


def get_cookie():
    body = ('<GetCookie xmlns="http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService">'
            "<oldCookie></oldCookie><lastChange>2015-10-21T17:01:07.1472913Z</lastChange>"
            "<currentTime>2017-12-02T00:16:15.217Z</currentTime><protocolVersion>1.40</protocolVersion>"
            "</GetCookie>")
    root = soap(FE3, "GetCookie", body)
    return root.find(".//w:EncryptedData", NS).text


def sync_updates(category_id, cookie, auth_xml=""):
    ids = "".join(f"<int>{i}</int>" for i in INSTALLED_NON_LEAF_UPDATE_IDS)
    body = f"""<SyncUpdates xmlns="http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService">
<cookie><Expiration>2045-03-11T02:02:48Z</Expiration><EncryptedData>{cookie}</EncryptedData></cookie>
<parameters>
<ExpressQuery>false</ExpressQuery>
<InstalledNonLeafUpdateIDs>{ids}</InstalledNonLeafUpdateIDs>
<OtherCachedUpdateIDs/>
<SkipSoftwareSync>false</SkipSoftwareSync>
<NeedTwoGroupOutOfScopeUpdates>true</NeedTwoGroupOutOfScopeUpdates>
<FilterAppCategoryIds><CategoryIdentifier><Id>{category_id}</Id></CategoryIdentifier></FilterAppCategoryIds>
<TreatAppCategoryIdsAsInstalled>true</TreatAppCategoryIdsAsInstalled>
<AlsoPerformRegularSync>false</AlsoPerformRegularSync>
<ComputerSpec/>
<ExtendedUpdateInfoParameters><XmlUpdateFragmentTypes><XmlUpdateFragmentType>Extended</XmlUpdateFragmentType></XmlUpdateFragmentTypes><Locales><string>en-US</string><string>en</string></Locales></ExtendedUpdateInfoParameters>
<ClientPreferredLanguages><string>en-US</string></ClientPreferredLanguages>
<ProductsParameters>
<SyncCurrentVersionOnly>false</SyncCurrentVersionOnly>
<DeviceAttributes>{DEVICE_ATTRIBUTES}</DeviceAttributes>
<CallerAttributes>Interactive=1;IsSeeker=0;</CallerAttributes>
<Products/>
</ProductsParameters>
</parameters>
</SyncUpdates>"""
    return soap(FE3, "SyncUpdates", body, auth_xml).find(".//w:SyncUpdatesResult", NS)


def _version_tuple(v):
    return tuple(int(p) if p.isdigit() else 0 for p in v.split("."))


def _ulong_version(n):
    return ".".join(str((n >> s) & 0xFFFF) for s in (48, 32, 16, 0))


def parse_packages(result):
    """Join NewUpdates (identity, moniker, applicability) with ExtendedUpdateInfo (files)."""
    ext = {}
    for u in result.findall("w:ExtendedUpdateInfo/w:Updates/w:Update", NS):
        ext[u.find("w:ID", NS).text] = u.find("w:Xml", NS).text or ""

    packages = {}
    for u in result.findall("w:NewUpdates/w:UpdateInfo", NS):
        # The fragments are XML without a single root element.
        info = ET.fromstring("<r>" + (u.find("w:Xml", NS).text or "") + "</r>")
        if info.find("Properties/SecuredFragment") is None:
            continue  # no downloadable file behind this update
        meta = info.find(".//AppxMetadata")
        if meta is None:
            continue
        ident = info.find("UpdateIdentity")
        moniker = meta.get("PackageMoniker")
        blob_el = meta.find("ApplicabilityBlob")
        blob = json.loads(html.unescape(blob_el.text)) if blob_el is not None and blob_el.text else {}

        files = ET.fromstring("<r>" + ext.get(u.find("w:ID", NS).text, "") + "</r>")
        main = None
        for f in files.findall("Files/File"):
            if f.get("PatchingType") is None and not f.get("FileName", "").startswith("Abm_"):
                main = f
                break
        name, version, arch, _, publisher = (moniker.split("_") + [""] * 5)[:5]
        sha256 = None
        if main is not None:
            ad = main.find("AdditionalDigest[@Algorithm='SHA256']")
            sha256 = ad.text if ad is not None else None
        packages[(ident.get("UpdateID"), ident.get("RevisionNumber"))] = {
            "moniker": moniker,
            "name": name,
            "version": version,
            "arch": arch,
            "publisher_id": publisher,
            "update_id": ident.get("UpdateID"),
            "revision": ident.get("RevisionNumber"),
            "file_ext": os.path.splitext(main.get("FileName"))[1].lower() if main is not None else "",
            "size": int(main.get("Size")) if main is not None else None,
            "modified": main.get("Modified") if main is not None else None,
            "sha1_b64": main.get("Digest") if main is not None else None,
            "sha256_b64": sha256,
            "min_os": sorted({f'{PLATFORMS.get(p["platform.target"], "target " + str(p["platform.target"]))} {_ulong_version(p["platform.minVersion"])}'
                              for p in blob.get("content.targetPlatforms", [])}),
            "bundled": blob.get("content.bundledPackages", []),
        }
    return sorted(packages.values(), key=lambda p: (p["name"].lower(), _version_tuple(p["version"]), p["arch"]))


def get_file_urls(update_id, revision, auth_xml=""):
    body = f"""<GetExtendedUpdateInfo2 xmlns="http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService">
<updateIDs><UpdateIdentity><UpdateID>{update_id}</UpdateID><RevisionNumber>{revision}</RevisionNumber></UpdateIdentity></updateIDs>
<infoTypes><XmlUpdateFragmentType>FileUrl</XmlUpdateFragmentType><XmlUpdateFragmentType>FileDecryption</XmlUpdateFragmentType></infoTypes>
<deviceAttributes>{DEVICE_ATTRIBUTES}</deviceAttributes>
</GetExtendedUpdateInfo2>"""
    root = soap(FE3_SECURED, "GetExtendedUpdateInfo2", body, auth_xml)
    out = []
    for loc in root.iter("{%s}FileLocation" % NS["w"]):
        out.append((loc.find("w:FileDigest", NS).text, loc.find("w:Url", NS).text))
    return out


def fetch(args):
    auth = args.msa_token or ""
    title, category, pfn = dcat_lookup(args.id, args.idtype, args.market, args.lang)
    packages = parse_packages(sync_updates(category, get_cookie(), auth))
    main_name = pfn.rsplit("_", 1)[0] if pfn else None
    if main_name and not args.deps:
        packages = [p for p in packages if p["name"].lower() == main_name.lower()]
    return title, category, pfn, packages


def cmd_list(args):
    title, category, pfn, packages = fetch(args)
    if args.json:
        json.dump({"title": title, "wuCategoryId": category, "packageFamilyName": pfn,
                   "packages": packages}, sys.stdout, indent=2)
        print()
        return
    print(f"{title}  [{pfn}]  WuCategoryId={category}  ({len(packages)} packages)\n")
    print(f"{'NAME':<40} {'VERSION':<20} {'ARCH':<8} {'TYPE':<13} {'SIZE MB':>8}  {'FILE DATE':<10}  MIN OS")
    for p in packages:
        size = f"{p['size'] / 1e6:.1f}" if p["size"] else "?"
        print(f"{p['name'][:40]:<40} {p['version']:<20} {p['arch'] or '-':<8} {p['file_ext']:<13} "
              f"{size:>8}  {(p['modified'] or '')[:10]:<10}  {', '.join(p['min_os'])}")
    enc = [p for p in packages if p["file_ext"].startswith(".e")]
    if enc:
        print(f"\nNote: {len(enc)} package(s) are encrypted (.e*). They need a Store licence "
              "and cannot be sideloaded.")


def cmd_download(args):
    title, category, pfn, packages = fetch(args)
    matches = [p for p in packages if p["version"] == args.version
               and (not args.arch or p["arch"].lower() == args.arch.lower())
               and (not args.name or p["name"].lower() == args.name.lower())]
    if not args.encrypted:
        plain = [p for p in matches if not p["file_ext"].startswith(".e")]
        matches = plain or matches
    if not matches:
        sys.exit(f"No package with version {args.version}. Run 'list' to see available versions.")
    if len(matches) > 1:
        sys.exit("Several packages match; add --arch/--name:\n  " + "\n  ".join(p["moniker"] + p["file_ext"] for p in matches))
    p = matches[0]
    urls = get_file_urls(p["update_id"], p["revision"], args.msa_token or "")
    url = next((u for d, u in urls if d == p["sha1_b64"]), None)
    if not url:
        sys.exit(f"FE3 returned no URL for {p['moniker']} ({p['update_id']} rev {p['revision']}).")
    if args.url_only:
        print(url)
        return
    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, p["moniker"] + p["file_ext"])
    h256 = hashlib.sha256()
    with http(url, headers={"User-Agent": "Microsoft-Delivery-Optimization/10.0"}) as r, open(path, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        done = 0
        while chunk := r.read(1 << 20):
            f.write(chunk)
            h256.update(chunk)
            done += len(chunk)
            if total and sys.stderr.isatty():
                print(f"\r{done * 100 // total:3d}% {path}", end="", file=sys.stderr)
    if sys.stderr.isatty():
        print(file=sys.stderr)
    if p["sha256_b64"] and base64.b64encode(h256.digest()).decode() != p["sha256_b64"]:
        os.remove(path)
        sys.exit("SHA-256 mismatch against FE3 metadata; file deleted.")
    print(f"{path}  (SHA-256 verified against FE3 metadata)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("id", help="Store product ID (e.g. 9WZDNCRFHVN5), or a PFN with --idtype pfn")
    common.add_argument("--idtype", choices=["productid", "pfn", "cid", "xti"], default="productid")
    common.add_argument("--market", default="US")
    common.add_argument("--lang", default="en")
    common.add_argument("--deps", action="store_true", help="include dependency packages (VCLibs, UI.Xaml, ...)")
    common.add_argument("--msa-token", help="optional <Device>/<User> ticket XML for flighted or private listings")
    sub = ap.add_subparsers(dest="cmd", required=True)
    lp = sub.add_parser("list", parents=[common], help="list all versions FE3 still serves")
    lp.add_argument("--json", action="store_true")
    lp.set_defaults(func=cmd_list)
    dp = sub.add_parser("download", parents=[common], help="download one version")
    dp.add_argument("--version", required=True)
    dp.add_argument("--arch", help="x64, x86, arm64, arm, neutral")
    dp.add_argument("--name", help="package name, for dependencies (with --deps)")
    dp.add_argument("--encrypted", action="store_true", help="allow encrypted .e* packages")
    dp.add_argument("--url-only", action="store_true", help="print the signed CDN URL instead of downloading")
    dp.add_argument("--out", default=".")
    dp.set_defaults(func=cmd_download)
    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
