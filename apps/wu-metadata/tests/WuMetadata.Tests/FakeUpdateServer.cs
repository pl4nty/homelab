using System.Net;
using System.Security;
using System.Text;
using System.Text.RegularExpressions;
using WuMetadata.Sync;

namespace WuMetadata.Tests;

/// <summary>
/// Answers the server-server sync calls a sync makes, serving the fixture updates. Tests change
/// <see cref="Updates"/> between syncs to add or drop revisions.
/// </summary>
public sealed partial class FakeUpdateServer : HttpMessageHandler
{
    public static readonly RevisionId Driver = new(Guid.Parse("687771e6-e4bb-4a93-9717-22ca7ac10e92"), 200);
    public static readonly RevisionId Software = new(Guid.Parse("5b2e80f1-de98-4d40-b5d2-b504443fa39b"), 201);
    public static readonly RevisionId Compressed = new(Guid.Parse("fc08b450-6bdd-400e-9a1a-2f86e23ce462"), 100);
    public static readonly RevisionId Product = new(Guid.Parse("05eebf61-148b-43cf-80da-1c99ab0b8699"), 1);
    public static readonly RevisionId Classification = new(Guid.Parse("ebfc1fc5-71a4-4f7b-9aca-3b9a503104a0"), 1);

    public const string DriverUrl = "http://download.windowsupdate.com/d/msdownload/update/driver/drvs/2017/02/200042644_c938e3beaa0f1d36f69fd1d37e4f8198bd570174.cab";

    private const string Ns = "http://www.microsoft.com/SoftwareDistribution";

    private static readonly Dictionary<RevisionId, string> Blobs = new()
    {
        [Driver] = $"<XmlUpdateBlob>{SecurityElement.Escape(Fixture("driver.xml"))}</XmlUpdateBlob>",
        [Software] = $"<XmlUpdateBlob>{SecurityElement.Escape(Fixture("software.xml"))}</XmlUpdateBlob>",
        [Compressed] = CompressedBlob().Match(Fixture("get-update-data.xml")).Value,
        [Product] = $"<XmlUpdateBlob>{SecurityElement.Escape(Fixture("category.xml"))}</XmlUpdateBlob>",
        [Classification] = $"<XmlUpdateBlob>{SecurityElement.Escape(Fixture("classification.xml"))}</XmlUpdateBlob>",
    };

    public List<RevisionId> Categories { get; } = [Product, Classification];

    public List<RevisionId> Updates { get; } = [Driver, Software, Compressed];

    public List<string> UpdateFilters { get; } = [];

    private int _getUpdateDataCalls;

    public int GetUpdateDataCalls => _getUpdateDataCalls;

    public static string Fixture(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", name));

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var action = request.Headers.GetValues("SOAPAction").Single().Trim('"');
        var body = await request.Content!.ReadAsStringAsync(cancellationToken);
        var result = action[(action.LastIndexOf('/') + 1)..] switch
        {
            "GetAuthConfig" => $"<GetAuthConfigResponse xmlns=\"{Ns}\"><GetAuthConfigResult><LastChange>2024-01-01T00:00:00Z</LastChange><AuthInfo><AuthPlugInInfo><PlugInID>DssTargeting</PlugInID><ServiceUrl>DssAuthWebService/DssAuthWebService.asmx</ServiceUrl><Parameter /></AuthPlugInInfo></AuthInfo></GetAuthConfigResult></GetAuthConfigResponse>",
            "GetAuthorizationCookie" => "<GetAuthorizationCookieResponse xmlns=\"http://www.microsoft.com/SoftwareDistribution/Server/DssAuthWebService\"><GetAuthorizationCookieResult><PlugInId>DssTargeting</PlugInId><CookieData>ZHNz</CookieData></GetAuthorizationCookieResult></GetAuthorizationCookieResponse>",
            "GetCookie" => $"<GetCookieResponse xmlns=\"{Ns}\"><GetCookieResult><Expiration>{DateTime.UtcNow.AddHours(1):O}</Expiration><EncryptedData>Y29va2ll</EncryptedData></GetCookieResult></GetCookieResponse>",
            "GetConfigData" => $"<GetConfigDataResponse xmlns=\"{Ns}\"><GetConfigDataResult><MaxNumberOfUpdatesPerRequest>2</MaxNumberOfUpdatesPerRequest></GetConfigDataResult></GetConfigDataResponse>",
            "GetRevisionIdList" => RevisionIdList(body),
            "GetUpdateData" => UpdateData(body),
            _ => null,
        };
        if (result is null)
        {
            return new HttpResponseMessage(HttpStatusCode.InternalServerError) { Content = new StringContent($"unexpected {action}") };
        }
        return new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                $"<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body>{result}</s:Body></s:Envelope>",
                Encoding.UTF8, "text/xml"),
        };
    }

    private string RevisionIdList(string body)
    {
        var config = body.Contains("<GetConfig>true</GetConfig>", StringComparison.Ordinal);
        if (!config)
        {
            UpdateFilters.Add(body);
        }
        var identities = string.Concat((config ? Categories : Updates).Select(id =>
            $"<UpdateIdentity><UpdateID>{id.UpdateId}</UpdateID><RevisionNumber>{id.Revision}</RevisionNumber></UpdateIdentity>"));
        return $"<GetRevisionIdListResponse xmlns=\"{Ns}\"><GetRevisionIdListResult><Anchor>anchor</Anchor><NewRevisions>{identities}</NewRevisions></GetRevisionIdListResult></GetRevisionIdListResponse>";
    }

    private string UpdateData(string body)
    {
        Interlocked.Increment(ref _getUpdateDataCalls);
        var updates = new StringBuilder();
        foreach (Match match in RequestedId().Matches(body))
        {
            var id = new RevisionId(Guid.Parse(match.Groups["id"].Value), int.Parse(match.Groups["revision"].Value, System.Globalization.CultureInfo.InvariantCulture));
            updates.Append($"<ServerSyncUpdateData><Id><UpdateID>{id.UpdateId}</UpdateID><RevisionNumber>{id.Revision}</RevisionNumber></Id>{Blobs[id]}</ServerSyncUpdateData>");
        }
        var urls = body.Contains(Driver.UpdateId.ToString(), StringComparison.Ordinal)
            ? $"<ServerSyncUrlData><FileDigest>yTjjvqoPHTb2n9HTfk+BmL1XAXQ=</FileDigest><MUUrl>{DriverUrl}</MUUrl></ServerSyncUrlData>"
            : string.Empty;
        return $"<GetUpdateDataResponse xmlns=\"{Ns}\"><GetUpdateDataResult><updates>{updates}</updates><fileUrls>{urls}</fileUrls></GetUpdateDataResult></GetUpdateDataResponse>";
    }

    [GeneratedRegex("<XmlUpdateBlobCompressed>[^<]+</XmlUpdateBlobCompressed>")]
    private static partial Regex CompressedBlob();

    [GeneratedRegex("<UpdateID>(?<id>[^<]+)</UpdateID><RevisionNumber>(?<revision>[^<]+)</RevisionNumber>")]
    private static partial Regex RequestedId();
}
