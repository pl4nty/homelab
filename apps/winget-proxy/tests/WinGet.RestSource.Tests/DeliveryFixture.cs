using System.Net;

namespace WinGet.RestSource.Tests;

/// <summary>Answers FE3 SOAP calls with responses trimmed from a real Windows Terminal sync.</summary>
public sealed class FakeDeliveryHandler : HttpMessageHandler
{
    public List<string> Actions { get; } = [];

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var body = await request.Content!.ReadAsStringAsync(cancellationToken);
        var action = new[] { "GetCookie", "SyncUpdates", "GetExtendedUpdateInfo2" }
            .First(name => body.Contains($"ClientWebService/{name}<", StringComparison.Ordinal));
        Actions.Add(action);

        var content = action == "GetExtendedUpdateInfo2"
            ? DeliveryFixture.FileUrlsResponse
            : File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", $"{action}.xml"));

        return new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(content, System.Text.Encoding.UTF8, "application/soap+xml"),
        };
    }
}

public static class DeliveryFixture
{
    public const string Latest = "3001.24.12741.0";
    public const string Previous = "3001.24.11911.0";

    public const string LatestUrl = "http://tlu.dl.delivery.mp.microsoft.com/filestreamingservice/files/latest?P1=1";
    public const string PreviousUrl = "http://tlu.dl.delivery.mp.microsoft.com/filestreamingservice/files/previous?P1=1";

    // SHA-256 of the msixbundles, from AdditionalDigest in Fixtures/SyncUpdates.xml.
    public static readonly string LatestSha256 = Hex("f7Bqng/240gEhRNJGXZ/1J5WkIS5YwPBtUzCOFtjrAk=");
    public static readonly string PreviousSha256 = Hex("JgRSVWdprFOA/gct0VVJxtJ+ufvgCM/r6Oj986AkyJs=");

    // Keyed by the files' SHA-1 digests; the block map entry is never an installer.
    public const string FileUrlsResponse = $"""
        <s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>
        <GetExtendedUpdateInfo2Response xmlns="http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService">
        <GetExtendedUpdateInfo2Result><FileLocations>
        <FileLocation><FileDigest>lx9z/HwbrGQ280fJkK7QLj3HQW8=</FileDigest><Url>{LatestUrl}</Url></FileLocation>
        <FileLocation><FileDigest>pV+Mh1c/cAuE83a5f0dVUS306d8=</FileDigest><Url>{PreviousUrl}</Url></FileLocation>
        <FileLocation><FileDigest>7rlcoZzlMrWpehpn2xQWuaWUQwM=</FileDigest><Url>http://dl.delivery.mp.microsoft.com/filestreamingservice/files/blockmap</Url></FileLocation>
        </FileLocations></GetExtendedUpdateInfo2Result>
        </GetExtendedUpdateInfo2Response>
        </s:Body></s:Envelope>
        """;

    private static string Hex(string base64) => Convert.ToHexString(Convert.FromBase64String(base64));
}
