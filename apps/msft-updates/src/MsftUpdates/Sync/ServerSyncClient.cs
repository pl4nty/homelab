using System.Globalization;
using System.Net.Http.Headers;
using System.Security;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Xml;
using System.Xml.Linq;
using Microsoft.Extensions.Options;

namespace MsftUpdates.Sync;

public sealed class SyncOptions
{
    /// <summary>The upstream update server; Microsoft Update unless pointed at a WSUS upstream.</summary>
    public Uri Endpoint { get; set; } = new("https://sws.update.microsoft.com/");

    /// <summary>Concurrent GetUpdateData requests during a sync.</summary>
    public int Parallelism { get; set; } = 16;

    /// <summary>Update XML held between download and write during a sync, as UTF-16 bytes.</summary>
    public long BufferBytes { get; set; } = 512L << 20;

    /// <summary>How often a sync runs; the first runs at startup.</summary>
    public TimeSpan Interval { get; set; } = TimeSpan.FromHours(1);

    /// <summary>False fetches a random <see cref="SampleSize"/> new updates per sync, so previews don't pull the whole catalog.</summary>
    public bool Full { get; set; } = true;

    public int SampleSize { get; set; } = 2000;

    /// <summary>Rewrite the catalog without removed revisions once they are this fraction of all rows.</summary>
    public double CompactionThreshold { get; set; } = 0.05;
}

public readonly record struct RevisionId(Guid UpdateId, int Revision);

/// <summary>One update as GetUpdateData returns it: plain XML, or an LZX cabinet holding UTF-16 XML.</summary>
public sealed record RawUpdate(RevisionId Id, string? Xml, byte[]? Cabinet);

public sealed record UpdateData(IReadOnlyList<RawUpdate> Updates, IReadOnlyDictionary<string, string> FileUrls);

/// <summary>
/// Client for the WSUS server-server sync protocol ([MS-WSUSSS]) that WSUS uses to sync from Microsoft
/// Update. Anonymous DSS authentication is enough for the full catalog.
/// </summary>
public sealed class ServerSyncClient(HttpClient http, IOptions<SyncOptions> options)
{
    // sws.update.microsoft.com chains to a root that Mozilla-derived trust stores lack
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

    private const string Ns = "http://www.microsoft.com/SoftwareDistribution";
    private static readonly XNamespace Xmlns = Ns;
    private const string DssNs = "http://www.microsoft.com/SoftwareDistribution/Server/DssAuthWebService";
    private const string ServerSyncPath = "ServerSyncWebService/ServerSyncWebService.asmx";

    private readonly SemaphoreSlim _cookieLock = new(1, 1);
    private (string Xml, DateTimeOffset Expiration)? _cookie;

    public async Task<int> GetMaxUpdatesPerRequestAsync(CancellationToken ct)
    {
        var cookie = await GetCookieAsync(ct);
        using var reader = await PostAsync(ServerSyncPath, $"{Ns}/GetConfigData",
            $"<GetConfigData xmlns=\"{Ns}\">{cookie}</GetConfigData>", ct);
        return reader.ReadToFollowing("MaxNumberOfUpdatesPerRequest")
            ? reader.ReadElementContentAsInt()
            : throw new InvalidDataException("GetConfigData has no MaxNumberOfUpdatesPerRequest");
    }

    /// <summary>Category, product, classification and detectoid revisions.</summary>
    public Task<IReadOnlyList<RevisionId>> GetCategoryRevisionsAsync(CancellationToken ct) =>
        GetRevisionIdListAsync("<GetConfig>true</GetConfig><Get63LanguageOnly>false</Get63LanguageOnly>", ct);

    /// <summary>
    /// Every current update revision in the given products and classifications. An empty filter returns
    /// nothing, so callers pass every product and classification for the full catalog.
    /// </summary>
    public Task<IReadOnlyList<RevisionId>> GetUpdateRevisionsAsync(
        IEnumerable<Guid> products, IEnumerable<Guid> classifications, CancellationToken ct)
    {
        static string Ids(string element, IEnumerable<Guid> ids) =>
            $"<{element}>{string.Concat(ids.Select(id => $"<IdAndDelta><Id>{id}</Id><Delta>false</Delta></IdAndDelta>"))}</{element}>";

        return GetRevisionIdListAsync(
            $"<GetConfig>false</GetConfig><Get63LanguageOnly>false</Get63LanguageOnly>{Ids("Categories", products)}{Ids("Classifications", classifications)}",
            ct);
    }

    public async Task<UpdateData> GetUpdateDataAsync(IReadOnlyCollection<RevisionId> ids, CancellationToken ct)
    {
        var cookie = await GetCookieAsync(ct);
        var body = new StringBuilder($"<GetUpdateData xmlns=\"{Ns}\">{cookie}<updateIds>");
        foreach (var id in ids)
        {
            body.Append(CultureInfo.InvariantCulture,
                $"<UpdateIdentity><UpdateID>{id.UpdateId}</UpdateID><RevisionNumber>{id.Revision}</RevisionNumber></UpdateIdentity>");
        }
        body.Append("</updateIds></GetUpdateData>");

        using var reader = await PostAsync(ServerSyncPath, $"{Ns}/GetUpdateData", body.ToString(), ct);
        var updates = new List<RawUpdate>(ids.Count);
        var urls = new Dictionary<string, string>();
        reader.MoveToContent();
        while (!reader.EOF)
        {
            if (reader.NodeType != XmlNodeType.Element || reader.LocalName is not ("ServerSyncUpdateData" or "ServerSyncUrlData"))
            {
                reader.Read();
                continue;
            }
            // ReadFrom leaves the reader on the next node
            var element = (XElement)XNode.ReadFrom(reader);
            string? Child(string name) => element.Descendants(Xmlns + name).FirstOrDefault()?.Value;
            if (element.Name.LocalName == "ServerSyncUrlData")
            {
                if (Child("FileDigest") is { } digest && Child("MUUrl") is { Length: > 0 } location)
                {
                    urls[digest] = location;
                }
                continue;
            }
            updates.Add(new RawUpdate(
                new RevisionId(Guid.Parse(Child("UpdateID")!), int.Parse(Child("RevisionNumber")!, CultureInfo.InvariantCulture)),
                Child("XmlUpdateBlob") is { Length: > 0 } xml ? xml : null,
                Child("XmlUpdateBlobCompressed") is { } cabinet ? Convert.FromBase64String(cabinet) : null));
        }
        return new UpdateData(updates, urls);
    }

    private async Task<IReadOnlyList<RevisionId>> GetRevisionIdListAsync(string filter, CancellationToken ct)
    {
        var cookie = await GetCookieAsync(ct);
        using var reader = await PostAsync(ServerSyncPath, $"{Ns}/GetRevisionIdList",
            $"<GetRevisionIdList xmlns=\"{Ns}\">{cookie}<filter>{filter}</filter></GetRevisionIdList>", ct);
        var ids = new List<RevisionId>();
        while (reader.ReadToFollowing("UpdateIdentity", Ns))
        {
            reader.ReadToDescendant("UpdateID", Ns);
            var id = Guid.Parse(reader.ReadElementContentAsString());
            reader.MoveToContent();
            var revision = reader.ReadElementContentAsInt("RevisionNumber", Ns);
            ids.Add(new RevisionId(id, revision));
        }
        return ids;
    }

    /// <summary>The serialized access cookie, renewed through the DSS auth plug-in before it expires.</summary>
    private async Task<string> GetCookieAsync(CancellationToken ct)
    {
        await _cookieLock.WaitAsync(ct);
        try
        {
            if (_cookie is { } cached && cached.Expiration - DateTimeOffset.UtcNow > TimeSpan.FromMinutes(10))
            {
                return cached.Xml;
            }

            string serviceUrl, plugIn;
            using (var reader = await PostAsync(ServerSyncPath, $"{Ns}/GetAuthConfig", $"<GetAuthConfig xmlns=\"{Ns}\"/>", ct))
            {
                reader.ReadToFollowing("PlugInID", Ns);
                plugIn = reader.ReadElementContentAsString();
                reader.MoveToContent();
                serviceUrl = reader.ReadElementContentAsString("ServiceUrl", Ns);
            }

            string cookieData;
            using (var reader = await PostAsync(serviceUrl, $"{DssNs}/GetAuthorizationCookie",
                $"<GetAuthorizationCookie xmlns=\"{DssNs}\"><accountName>{Guid.Empty}</accountName><accountGuid>{Guid.Empty}</accountGuid></GetAuthorizationCookie>", ct))
            {
                reader.ReadToFollowing("CookieData", DssNs);
                cookieData = reader.ReadElementContentAsString();
            }

            using (var reader = await PostAsync(ServerSyncPath, $"{Ns}/GetCookie",
                $"<GetCookie xmlns=\"{Ns}\"><authCookies><AuthorizationCookie><PlugInId>{SecurityElement.Escape(plugIn)}</PlugInId><CookieData>{cookieData}</CookieData></AuthorizationCookie></authCookies><protocolVersion>1.7</protocolVersion></GetCookie>", ct))
            {
                reader.ReadToFollowing("Expiration", Ns);
                var expiration = reader.ReadElementContentAsString();
                reader.MoveToContent();
                var encrypted = reader.ReadElementContentAsString("EncryptedData", Ns);
                _cookie = ($"<cookie><Expiration>{expiration}</Expiration><EncryptedData>{encrypted}</EncryptedData></cookie>",
                    DateTimeOffset.Parse(expiration, CultureInfo.InvariantCulture));
            }
            return _cookie.Value.Xml;
        }
        finally
        {
            _cookieLock.Release();
        }
    }

    private async Task<XmlReader> PostAsync(string path, string action, string body, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(options.Value.Endpoint, path))
        {
            Content = new StringContent(
                $"<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body>{body}</s:Body></s:Envelope>",
                Encoding.UTF8),
        };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("text/xml") { CharSet = "utf-8" };
        request.Headers.Add("SOAPAction", $"\"{action}\"");

        var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        var stream = await response.Content.ReadAsStreamAsync(ct);
        if (!response.IsSuccessStatusCode)
        {
            using var fault = new StreamReader(stream);
            var text = await fault.ReadToEndAsync(ct);
            response.Dispose();
            throw new HttpRequestException($"{action} returned {(int)response.StatusCode}: {text[..Math.Min(text.Length, 500)]}");
        }
        return XmlReader.Create(stream, new XmlReaderSettings { IgnoreWhitespace = true, CloseInput = true });
    }
}
