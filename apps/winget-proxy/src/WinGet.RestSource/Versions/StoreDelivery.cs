using System.Net.Http.Headers;
using System.Security.Cryptography.X509Certificates;
using System.Xml.Linq;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;

namespace WinGet.RestSource.Versions;

public sealed class VersionsSourceOptions
{
    /// <summary>Upper bound on results returned from /manifestSearch; each result costs one FE3 sync.</summary>
    public int MaximumResults { get; set; } = 5;

    /// <summary>How long FE3 package lists are reused. File URLs are signed for minutes, so they are never cached.</summary>
    public TimeSpan CacheDuration { get; set; } = TimeSpan.FromMinutes(15);
}

/// <summary>
/// Client for FE3, the Windows Update delivery service the Store client uses (as do StoreLib and StoreWeb).
/// A sync filtered to a product's WuCategoryId returns every package in the product's live package set,
/// older versions included, and GetExtendedUpdateInfo2 signs a short-lived download URL for one of them.
/// </summary>
public sealed class StoreDelivery(HttpClient http, IMemoryCache cache, IOptions<VersionsSourceOptions> options)
{
    public const string Service = "https://fe3.delivery.mp.microsoft.com/ClientWebService/client.asmx";

    // FE3 serves a certificate from "Microsoft Update Secure Server CA 2.1", which chains to this root.
    // The root is not in Mozilla-derived trust stores, so the FE3 client trusts it alone.
    // https://www.microsoft.com/pki/certs/MicRooCerAut2011_2011_03_22.crt
    public static readonly X509Certificate2 Root = X509Certificate2.CreateFromPem("""
        -----BEGIN CERTIFICATE-----
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
        -----END CERTIFICATE-----
        """);

    private static readonly XNamespace Soap = "http://www.w3.org/2003/05/soap-envelope";
    private static readonly XNamespace Addressing = "http://www.w3.org/2005/08/addressing";
    private static readonly XNamespace Security = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd";
    private static readonly XNamespace Utility = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd";
    private static readonly XNamespace Authorization = "http://schemas.microsoft.com/msus/2014/10/WindowsUpdateAuthorization";
    private static readonly XNamespace Ws = "http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService";

    // Detectoid and category UpdateIDs the client claims are installed; FE3 returns no app packages
    // without them. From StoreLib's WUIDRequest.xml.
    private static readonly int[] InstalledNonLeafUpdateIds =
    [
        1, 2, 3, 11, 19, 544, 549, 2359974, 2359977, 5169044, 8788830, 23110993, 23110994, 54341900,
        54343656, 59830006, 59830007, 59830008, 60484010, 62450018, 62450019, 62450020, 66027979, 66053150,
        97657898, 98822896, 98959022, 98959023, 98959024, 98959025, 98959026, 104433538, 104900364, 105489019,
        117765322, 129905029, 130040031, 132387090, 132393049, 133399034, 138537048, 140377312, 143747671,
        158941041, 158941042, 158941043, 158941044, 159123858, 159130928, 164836897, 164847386, 164848327,
        164852241, 164852246, 164852252, 164852253,
    ];

    private const string DeviceAttributes =
        "BranchReadinessLevel=CB;CurrentBranch=rs_prerelease;OEMModel=Virtual Machine;FlightRing=WIS;" +
        "AttrDataVer=21;SystemManufacturer=Microsoft Corporation;InstallLanguage=en-US;OSUILocale=en-US;" +
        "InstallationType=Client;FlightingBranchName=external;FirmwareVersion=Hyper-V UEFI Release v2.5;" +
        "SystemProductName=Virtual Machine;OSSkuId=48;FlightContent=Branch;App=WU;" +
        "OEMName_Uncleaned=Microsoft Corporation;AppVer=10.0.16184.1001;OSArchitecture=AMD64;SystemSKU=None;" +
        "UpdateManagementGroup=2;IsFlightingEnabled=1;IsDeviceRetailDemo=0;TelemetryLevel=3;" +
        "OSVersion=10.0.16184.1001;DeviceFamily=Windows.Desktop;";

    private readonly VersionsSourceOptions _options = options.Value;

    /// <summary>Every package FE3 serves for the category, dependencies included.</summary>
    public Task<IReadOnlyList<DeliveryPackage>> GetPackagesAsync(string categoryId, CancellationToken ct) =>
        cache.GetOrCreateAsync($"fe3:{categoryId}", async entry =>
        {
            entry.AbsoluteExpirationRelativeToNow = _options.CacheDuration;

            var cookie = (await SendAsync(Service, "GetCookie", new XElement(Ws + "GetCookie",
                    new XElement(Ws + "oldCookie"),
                    new XElement(Ws + "lastChange", "2015-10-21T17:01:07.1472913Z"),
                    new XElement(Ws + "currentTime", "2017-12-02T00:16:15.217Z"),
                    new XElement(Ws + "protocolVersion", "1.40")), ct))
                .Descendants(Ws + "EncryptedData").First().Value;

            var result = (await SendAsync(Service, "SyncUpdates", new XElement(Ws + "SyncUpdates",
                new XElement(Ws + "cookie",
                    new XElement(Ws + "Expiration", "2045-03-11T02:02:48Z"),
                    new XElement(Ws + "EncryptedData", cookie)),
                new XElement(Ws + "parameters",
                    new XElement(Ws + "ExpressQuery", false),
                    new XElement(Ws + "InstalledNonLeafUpdateIDs", InstalledNonLeafUpdateIds.Select(id => new XElement(Ws + "int", id))),
                    new XElement(Ws + "OtherCachedUpdateIDs"),
                    new XElement(Ws + "SkipSoftwareSync", false),
                    new XElement(Ws + "NeedTwoGroupOutOfScopeUpdates", true),
                    new XElement(Ws + "FilterAppCategoryIds",
                        new XElement(Ws + "CategoryIdentifier", new XElement(Ws + "Id", categoryId))),
                    new XElement(Ws + "TreatAppCategoryIdsAsInstalled", true),
                    new XElement(Ws + "AlsoPerformRegularSync", false),
                    new XElement(Ws + "ComputerSpec"),
                    new XElement(Ws + "ExtendedUpdateInfoParameters",
                        new XElement(Ws + "XmlUpdateFragmentTypes", new XElement(Ws + "XmlUpdateFragmentType", "Extended")),
                        new XElement(Ws + "Locales", new XElement(Ws + "string", "en-US"), new XElement(Ws + "string", "en"))),
                    new XElement(Ws + "ClientPreferredLanguages", new XElement(Ws + "string", "en-US")),
                    new XElement(Ws + "ProductsParameters",
                        new XElement(Ws + "SyncCurrentVersionOnly", false),
                        new XElement(Ws + "DeviceAttributes", DeviceAttributes),
                        new XElement(Ws + "CallerAttributes", "Interactive=1;IsSeeker=0;"),
                        new XElement(Ws + "Products")))), ct))
                .Descendants(Ws + "SyncUpdatesResult").FirstOrDefault();

            return result is null ? [] : Parse(result);
        })!;

    /// <summary>Signed download URLs for the packages' files, keyed by the file's SHA-1 digest.</summary>
    public async Task<IReadOnlyDictionary<string, string>> GetFileUrlsAsync(
        IEnumerable<DeliveryPackage> packages, CancellationToken ct)
    {
        var response = await SendAsync($"{Service}/secured", "GetExtendedUpdateInfo2", new XElement(Ws + "GetExtendedUpdateInfo2",
            new XElement(Ws + "updateIDs", packages.Select(package => new XElement(Ws + "UpdateIdentity",
                new XElement(Ws + "UpdateID", package.UpdateId),
                new XElement(Ws + "RevisionNumber", package.RevisionNumber)))),
            new XElement(Ws + "infoTypes",
                new XElement(Ws + "XmlUpdateFragmentType", "FileUrl"),
                new XElement(Ws + "XmlUpdateFragmentType", "FileDecryption")),
            new XElement(Ws + "deviceAttributes", DeviceAttributes)), ct);

        return response.Descendants(Ws + "FileLocation")
            .Select(location => (Digest: (string?)location.Element(Ws + "FileDigest"), Url: (string?)location.Element(Ws + "Url")))
            .Where(location => location.Digest is not null && location.Url is not null)
            .DistinctBy(location => location.Digest)
            .ToDictionary(location => location.Digest!, location => location.Url!);
    }

    /// <summary>Joins each update's identity and package moniker with its main file from the extended info.</summary>
    public static IReadOnlyList<DeliveryPackage> Parse(XElement result)
    {
        var files = result.Elements(Ws + "ExtendedUpdateInfo").Elements(Ws + "Updates").Elements(Ws + "Update")
            .ToDictionary(update => (string)update.Element(Ws + "ID")!, update => Fragment(update));

        return
        [
            .. result.Elements(Ws + "NewUpdates").Elements(Ws + "UpdateInfo")
                .Select(update => (Info: Fragment(update), Files: files.GetValueOrDefault((string)update.Element(Ws + "ID")!)))
                // Updates without a secured fragment have no downloadable file.
                .Where(update => update.Info.Element("Properties")?.Element("SecuredFragment") is not null)
                .Select(update => ToPackage(update.Info, update.Files))
                .OfType<DeliveryPackage>()
                .DistinctBy(package => (package.UpdateId, package.RevisionNumber)),
        ];
    }

    private static DeliveryPackage? ToPackage(XElement info, XElement? files)
    {
        var identity = info.Element("UpdateIdentity");
        var moniker = (string?)info.Descendants("AppxMetadata").FirstOrDefault()?.Attribute("PackageMoniker");

        // Delta patches and block maps sit beside the package itself.
        var file = files?.Element("Files")?.Elements("File").FirstOrDefault(file =>
            file.Attribute("PatchingType") is null &&
            !((string?)file.Attribute("FileName") ?? "").StartsWith("Abm_", StringComparison.Ordinal));

        if (identity is null || moniker is null || file is null)
        {
            return null;
        }

        // <Name>_<Version>_<Architecture>_<ResourceId>_<PublisherId>
        var parts = moniker.Split('_');
        if (parts.Length < 5)
        {
            return null;
        }

        var sha256 = (string?)file.Elements("AdditionalDigest")
            .FirstOrDefault(digest => (string?)digest.Attribute("Algorithm") == "SHA256");

        return new DeliveryPackage(
            UpdateId: (string)identity.Attribute("UpdateID")!,
            RevisionNumber: (string)identity.Attribute("RevisionNumber")!,
            Name: parts[0],
            Version: parts[1],
            Architecture: parts[2],
            PackageFamilyName: $"{parts[0]}_{parts[^1]}",
            FileExtension: Path.GetExtension((string?)file.Attribute("FileName") ?? "").ToLowerInvariant(),
            Sha1Digest: (string?)file.Attribute("Digest"),
            Sha256: sha256 is null ? null : Convert.ToHexString(Convert.FromBase64String(sha256)),
            Modified: (DateTimeOffset?)file.Attribute("Modified"));
    }

    // The update fragments are XML without a single root element.
    private static XElement Fragment(XElement update) =>
        XElement.Parse($"<r>{(string?)update.Element(Ws + "Xml")}</r>");

    private async Task<XElement> SendAsync(string url, string action, XElement body, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var envelope = new XElement(Soap + "Envelope",
            new XElement(Soap + "Header",
                new XElement(Addressing + "Action", new XAttribute(Soap + "mustUnderstand", 1), $"{Ws.NamespaceName}/{action}"),
                new XElement(Addressing + "MessageID", $"urn:uuid:{Guid.NewGuid()}"),
                new XElement(Addressing + "To", new XAttribute(Soap + "mustUnderstand", 1), url),
                new XElement(Security + "Security", new XAttribute(Soap + "mustUnderstand", 1),
                    new XElement(Utility + "Timestamp",
                        new XElement(Utility + "Created", now.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")),
                        new XElement(Utility + "Expires", now.AddMinutes(5).ToString("yyyy-MM-ddTHH:mm:ss.fffZ"))),
                    new XElement(Authorization + "WindowsUpdateTicketsToken",
                        new XAttribute(Utility + "id", "ClientMSA"),
                        new XElement("TicketType",
                            new XAttribute("Name", "MSA"), new XAttribute("Version", "1.0"), new XAttribute("Policy", "MBI_SSL"))))),
            new XElement(Soap + "Body", body));

        using var content = new StringContent(envelope.ToString(SaveOptions.DisableFormatting));
        content.Headers.ContentType = new MediaTypeHeaderValue("application/soap+xml") { CharSet = "utf-8" };

        using var response = await http.PostAsync(url, content, ct);
        response.EnsureSuccessStatusCode();

        return XElement.Parse(await response.Content.ReadAsStringAsync(ct));
    }
}

/// <summary>One package FE3 serves; <see cref="Sha256"/> is hex, as WinGet manifests carry it.</summary>
public sealed record DeliveryPackage(
    string UpdateId,
    string RevisionNumber,
    string Name,
    string Version,
    string Architecture,
    string PackageFamilyName,
    string FileExtension,
    string? Sha1Digest,
    string? Sha256,
    DateTimeOffset? Modified)
{
    /// <summary>Encrypted packages (<c>.eappx</c>, <c>.emsixbundle</c>, …) install only with a Store licence.</summary>
    public bool IsEncrypted => FileExtension.StartsWith(".e", StringComparison.Ordinal);
}
