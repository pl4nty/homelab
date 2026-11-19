// Microsoft Store content: the display catalog maps a product ID to its WuCategoryId, and FE3 (the
// Windows Update service the Store client uses) lists the category's packages and signs their file URLs.
// Ported from apps/winget-proxy/src/WinGet.RestSource/Versions/StoreDelivery.cs.

const FE3 = 'https://fe3.delivery.mp.microsoft.com/ClientWebService/client.asmx';
const WS = 'http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService';

// Detectoid and category UpdateIDs the client claims are installed; FE3 returns no app packages without them.
const INSTALLED_NON_LEAF = [
  1, 2, 3, 11, 19, 544, 549, 2359974, 2359977, 5169044, 8788830, 23110993, 23110994, 54341900, 54343656, 59830006,
  59830007, 59830008, 60484010, 62450018, 62450019, 62450020, 66027979, 66053150, 97657898, 98822896, 98959022,
  98959023, 98959024, 98959025, 98959026, 104433538, 104900364, 105489019, 117765322, 129905029, 130040031, 132387090,
  132393049, 133399034, 138537048, 140377312, 143747671, 158941041, 158941042, 158941043, 158941044, 159123858,
  159130928, 164836897, 164847386, 164848327, 164852241, 164852246, 164852252, 164852253,
];

const DEVICE_ATTRIBUTES =
  'BranchReadinessLevel=CB;CurrentBranch=rs_prerelease;OEMModel=Virtual Machine;FlightRing=WIS;' +
  'AttrDataVer=21;SystemManufacturer=Microsoft Corporation;InstallLanguage=en-US;OSUILocale=en-US;' +
  'InstallationType=Client;FlightingBranchName=external;FirmwareVersion=Hyper-V UEFI Release v2.5;' +
  'SystemProductName=Virtual Machine;OSSkuId=48;FlightContent=Branch;App=WU;' +
  'OEMName_Uncleaned=Microsoft Corporation;AppVer=10.0.16184.1001;OSArchitecture=AMD64;SystemSKU=None;' +
  'UpdateManagementGroup=2;IsFlightingEnabled=1;IsDeviceRetailDemo=0;TelemetryLevel=3;' +
  'OSVersion=10.0.16184.1001;DeviceFamily=Windows.Desktop;';

export type StoreFile = {
  name: string;
  moniker: string;
  updateId: string;
  revision: string;
  size: number;
  sha1: string;
  sha256?: string;
};

export type StoreProduct = { productId: string; title?: string; wuCategoryId: string; files: StoreFile[] };

const escapeXml = (s: string) => s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
const unescapeXml = (s: string) =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+);/g, (_, e: string) =>
    e[0] === '#' ? String.fromCharCode(Number(e.slice(1))) : { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e]!,
  );
const attr = (xml: string, name: string) => xml.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
const elements = (xml: string, name: string) =>
  [...xml.matchAll(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1]);

async function soap(url: string, action: string, body: string) {
  const now = new Date();
  const envelope = `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing"><s:Header><a:Action s:mustUnderstand="1">${WS}/${action}</a:Action><a:MessageID>urn:uuid:${crypto.randomUUID()}</a:MessageID><a:To s:mustUnderstand="1">${url}</a:To><o:Security s:mustUnderstand="1" xmlns:o="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><Timestamp xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"><Created>${now.toISOString()}</Created><Expires>${new Date(now.getTime() + 300000).toISOString()}</Expires></Timestamp><wuws:WindowsUpdateTicketsToken wsu:id="ClientMSA" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd" xmlns:wuws="http://schemas.microsoft.com/msus/2014/10/WindowsUpdateAuthorization"><TicketType Name="MSA" Version="1.0" Policy="MBI_SSL"></TicketType></wuws:WindowsUpdateTicketsToken></o:Security></s:Header><s:Body>${body}</s:Body></s:Envelope>`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
    body: envelope,
  });
  if (!res.ok) throw new Error(`FE3 ${action}: HTTP ${res.status}`);
  return res.text();
}

async function product(productId: string) {
  const res = await fetch(
    `https://displaycatalog.mp.microsoft.com/v7.0/products/${encodeURIComponent(productId)}?market=US&languages=en-US`,
  );
  if (!res.ok) throw new Error(`display catalog: HTTP ${res.status}`);
  const { Product } = await res.json();
  const wuCategoryId: string | undefined =
    Product?.DisplaySkuAvailabilities?.[0]?.Sku?.Properties?.FulfillmentData?.WuCategoryId;
  if (!wuCategoryId) throw new Error(`${productId} has no WuCategoryId, so FE3 does not deliver it`);
  return { title: Product.LocalizedProperties?.[0]?.ProductTitle as string | undefined, wuCategoryId };
}

export async function storeProduct(productId: string): Promise<StoreProduct> {
  const { title, wuCategoryId } = await product(productId);
  const cookie = elements(
    await soap(
      FE3,
      'GetCookie',
      `<GetCookie xmlns="${WS}"><oldCookie></oldCookie><lastChange>2015-10-21T17:01:07.1472913Z</lastChange><currentTime>2017-12-02T00:16:15.217Z</currentTime><protocolVersion>1.40</protocolVersion></GetCookie>`,
    ),
    'EncryptedData',
  )[0];
  const sync = await soap(
    FE3,
    'SyncUpdates',
    `<SyncUpdates xmlns="${WS}"><cookie><Expiration>2045-03-11T02:02:48Z</Expiration><EncryptedData>${cookie}</EncryptedData></cookie><parameters><ExpressQuery>false</ExpressQuery><InstalledNonLeafUpdateIDs>${INSTALLED_NON_LEAF.map((id) => `<int>${id}</int>`).join('')}</InstalledNonLeafUpdateIDs><OtherCachedUpdateIDs></OtherCachedUpdateIDs><SkipSoftwareSync>false</SkipSoftwareSync><NeedTwoGroupOutOfScopeUpdates>true</NeedTwoGroupOutOfScopeUpdates><FilterAppCategoryIds><CategoryIdentifier><Id>${wuCategoryId}</Id></CategoryIdentifier></FilterAppCategoryIds><TreatAppCategoryIdsAsInstalled>true</TreatAppCategoryIdsAsInstalled><AlsoPerformRegularSync>false</AlsoPerformRegularSync><ComputerSpec></ComputerSpec><ExtendedUpdateInfoParameters><XmlUpdateFragmentTypes><XmlUpdateFragmentType>Extended</XmlUpdateFragmentType></XmlUpdateFragmentTypes><Locales><string>en-US</string><string>en</string></Locales></ExtendedUpdateInfoParameters><ClientPreferredLanguages><string>en-US</string></ClientPreferredLanguages><ProductsParameters><SyncCurrentVersionOnly>false</SyncCurrentVersionOnly><DeviceAttributes>${escapeXml(DEVICE_ATTRIBUTES)}</DeviceAttributes><CallerAttributes>Interactive=1;IsSeeker=0;</CallerAttributes><Products></Products></ProductsParameters></parameters></SyncUpdates>`,
  );

  // Extended fragments carry the files, keyed by the update's numeric ID; NewUpdates carry identity and moniker.
  const extended = new Map<string, string>();
  for (const update of elements(elements(sync, 'ExtendedUpdateInfo')[0] ?? '', 'Update')) {
    extended.set(elements(update, 'ID')[0], unescapeXml(elements(update, 'Xml')[0] ?? ''));
  }
  const files: StoreFile[] = [];
  for (const update of elements(elements(sync, 'NewUpdates')[0] ?? '', 'UpdateInfo')) {
    const info = unescapeXml(elements(update, 'Xml')[0] ?? '');
    if (!info.includes('<SecuredFragment')) continue;
    const identity = info.match(/<UpdateIdentity\b[^>]*>/)?.[0] ?? '';
    const moniker = attr(info.match(/<AppxMetadata\b[^>]*>/)?.[0] ?? '', 'PackageMoniker');
    const ext = extended.get(elements(update, 'ID')[0]) ?? '';
    // delta patches and block maps sit beside the package itself
    const file = [...ext.matchAll(/<File\b[^>]*>[\s\S]*?<\/File>|<File\b[^>]*\/>/g)]
      .map((m) => m[0])
      .find((f) => !attr(f, 'PatchingType') && !attr(f, 'FileName')?.startsWith('Abm_'));
    if (!moniker || !file) continue;
    const sha256 = file.match(/<AdditionalDigest Algorithm="SHA256">([^<]+)</)?.[1];
    files.push({
      name: attr(file, 'FileName') ?? '',
      moniker,
      updateId: attr(identity, 'UpdateID') ?? '',
      revision: attr(identity, 'RevisionNumber') ?? '',
      size: Number(attr(file, 'Size') ?? 0),
      sha1: attr(file, 'Digest') ?? '',
      sha256: sha256 && Buffer.from(sha256, 'base64').toString('hex').toUpperCase(),
    });
  }
  const unique = [...new Map(files.map((f) => [`${f.updateId}/${f.revision}`, f])).values()];
  return { productId, title, wuCategoryId, files: unique };
}

// FE3 signs a URL valid for minutes, and rejects requests for many updates at once, so one file per call.
export async function storeFileUrl(updateId: string, revision: string) {
  const urls = await soap(
    `${FE3}/secured`,
    'GetExtendedUpdateInfo2',
    `<GetExtendedUpdateInfo2 xmlns="${WS}"><updateIDs><UpdateIdentity><UpdateID>${escapeXml(updateId)}</UpdateID><RevisionNumber>${escapeXml(revision)}</RevisionNumber></UpdateIdentity></updateIDs><infoTypes><XmlUpdateFragmentType>FileUrl</XmlUpdateFragmentType><XmlUpdateFragmentType>FileDecryption</XmlUpdateFragmentType></infoTypes><deviceAttributes>${escapeXml(DEVICE_ATTRIBUTES)}</deviceAttributes></GetExtendedUpdateInfo2>`,
  );
  return elements(urls, 'FileLocation').map((l) => ({
    sha1: elements(l, 'FileDigest')[0],
    url: unescapeXml(elements(l, 'Url')[0] ?? ''),
  }));
}

// The msstore WinGet source. Win32 apps (XP… IDs) list installer URLs and SHA256s; WinGet hands DO the
// SHA256 as ContentId. MSIX apps (9… IDs) list only the product ID, and the Store client gets them from FE3.
export async function storeInstallers(productId: string) {
  const res = await fetch(
    `https://storeedgefd.dsx.mp.microsoft.com/v9.0/packageManifests/${encodeURIComponent(productId)}?Market=US`,
  );
  if (!res.ok) throw new Error(`storeedgefd: HTTP ${res.status}`);
  const version = (await res.json()).Data?.Versions?.[0];
  const installers: {
    InstallerUrl?: string;
    InstallerSha256?: string;
    Architecture?: string;
    InstallerType?: string;
    Scope?: string;
    InstallerLocale?: string;
  }[] = version?.Installers ?? [];
  return {
    title: version?.DefaultLocale?.PackageName as string | undefined,
    version: version?.PackageVersion as string | undefined,
    installers: [
      ...new Map(
        installers
          .filter((i) => i.InstallerUrl)
          .map((i) => [
            i.InstallerUrl,
            { url: i.InstallerUrl!, sha256: i.InstallerSha256, architecture: i.Architecture, type: i.InstallerType },
          ]),
      ).values(),
    ],
  };
}
