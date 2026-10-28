using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Web;

namespace WinGet.RestSource.Tests;

public sealed class FakeStoreHandler : HttpMessageHandler
{
    public List<Uri> Requests { get; } = [];

    public IEnumerable<Uri> SuggestRequests => Requests.Where(uri => uri.AbsolutePath.EndsWith("autosuggest"));

    /// <summary>Store IDs the display catalog was asked for details about.</summary>
    public IEnumerable<string> DetailedProductIds => Requests
        .SelectMany(uri => HttpUtility.ParseQueryString(uri.Query)["bigIds"]?.Split(',') ?? []);

    public static string Market(Uri uri) => HttpUtility.ParseQueryString(uri.Query)["market"] ?? string.Empty;

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var uri = request.RequestUri!;
        Requests.Add(uri);

        var content = request.Method == HttpMethod.Post
            ? StoreFixture.StorefrontResponse(
                (await request.Content!.ReadFromJsonAsync<StorefrontRequest>(RestSourceFactory.Json, cancellationToken))!.ProductIds)
            : uri.AbsolutePath.EndsWith("autosuggest")
                ? HttpUtility.ParseQueryString(uri.Query)["productFamilyNames"] == "Apps"
                    ? StoreFixture.AppSuggestResponse
                    : StoreFixture.SuggestResponse
                : StoreFixture.ProductsResponse(HttpUtility.ParseQueryString(uri.Query)["bigIds"]?.Split(',') ?? []);

        return new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(content, System.Text.Encoding.UTF8, "application/json"),
        };
    }

    public sealed record StorefrontRequest(IReadOnlyList<string> ProductIds);
}

/// <summary>Trimmed copies of real Store payloads.</summary>
public static class StoreFixture
{
    public const string WindowsGameId = "9PMF91N3LZ3M";       // installable on a PC
    public const string PlayAnywhereGameId = "9NP1P1WFS0LB";  // installable, but publishes no packages
    public const string ConsoleGameId = "BQ1TN1T79V9K";       // Xbox console only
    public const string ConsumableId = "C3S80L2NKZCZ";
    public const string ApplicationId = "9WZDNCRFJ3TJ";
    public const string TerminalId = "9N0DX20HK701";        // an MSIX app FE3 delivers

    /// <summary>What the Store storefront reports as installable for deviceFamily=Windows.Desktop.</summary>
    private static readonly HashSet<string> Installable = [WindowsGameId, PlayAnywhereGameId, ApplicationId, ConsumableId];

    public const string SuggestResponse = """
        {
          "Results": [{ "Products": [
            { "ProductId": "BQ1TN1T79V9K", "Type": "Game" },
            { "ProductId": "9PMF91N3LZ3M", "Type": "Game" },
            { "ProductId": "C3S80L2NKZCZ", "Type": "Consumable" },
            { "ProductId": "9NP1P1WFS0LB", "Type": "Game" }
          ]}]
        }
        """;

    public const string AppSuggestResponse = """
        {
          "Results": [{ "Products": [
            { "ProductId": "9N0DX20HK701", "Type": "Application" },
            { "ProductId": "9PMF91N3LZ3M", "Type": "Game" }
          ]}]
        }
        """;

    private static readonly Dictionary<string, string> Products = new()
    {
        [TerminalId] = """
            {
              "ProductId": "9N0DX20HK701",
              "ProductKind": "Application",
              "LocalizedProperties": [{
                "ProductTitle": "Windows Terminal",
                "PublisherName": "Microsoft Corporation",
                "ShortDescription": "The new Windows Terminal.",
                "Language": "en-us"
              }],
              "Properties": { "PackageFamilyName": "Microsoft.WindowsTerminal_8wekyb3d8bbwe" },
              "DisplaySkuAvailabilities": [{ "Sku": { "Properties": {
                "Packages": [{
                  "PlatformDependencies": [{ "PlatformName": "Windows.Desktop" }],
                  "FulfillmentData": {
                    "PackageFamilyName": "Microsoft.WindowsTerminal_8wekyb3d8bbwe",
                    "WuCategoryId": "b5105a40-6423-4c74-9c74-49610e83bc05"
                  }
                }]
              }}}]
            }
            """,
        [WindowsGameId] = """
            {
              "ProductId": "9PMF91N3LZ3M",
              "ProductKind": "Game",
              "LocalizedProperties": [{
                "ProductTitle": "Roblox - Windows",
                "PublisherName": "Roblox Corporation",
                "PublisherWebsiteUri": "https://roblox.com/",
                "SupportUri": "",
                "ShortDescription": "Roblox is the ultimate virtual universe.",
                "Language": "en-us"
              }],
              "MarketProperties": [{ "OriginalReleaseDate": "2016-01-27T00:00:00.0000000Z" }],
              "Properties": { "PackageFamilyName": "ROBLOXCorporation.RobloxGDK_55nm5eh3cm0pr" },
              "DisplaySkuAvailabilities": [{ "Sku": { "Properties": {
                "VersionString": "",
                "Packages": [{
                  "PlatformDependencies": [{ "PlatformName": "Windows.Desktop" }],
                  "FulfillmentData": { "PackageFamilyName": "ROBLOXCorporation.RobloxGDK_55nm5eh3cm0pr" }
                }]
              }}}]
            }
            """,
        // Play Anywhere titles are installable on a PC but publish no packages in the catalog.
        [PlayAnywhereGameId] = """
            {
              "ProductId": "9NP1P1WFS0LB",
              "ProductKind": "Game",
              "LocalizedProperties": [{
                "ProductTitle": "Halo Infinite",
                "PublisherName": "Xbox Game Studios",
                "ShortDescription": "Master Chief returns.",
                "Language": "en-us"
              }],
              "DisplaySkuAvailabilities": [{ "Sku": { "Properties": { "VersionString": "1.0.13", "Packages": [] } } }]
            }
            """,
        [ConsoleGameId] = """
            {
              "ProductId": "BQ1TN1T79V9K",
              "ProductKind": "Game",
              "LocalizedProperties": [{ "ProductTitle": "Roblox - Xbox", "PublisherName": "ROBLOX", "Language": "en-us" }],
              "DisplaySkuAvailabilities": [{ "Sku": { "Properties": {
                "Packages": [{ "PlatformDependencies": [{ "PlatformName": "Windows.Xbox" }] }]
              }}}]
            }
            """,
        [ConsumableId] = """
            {
              "ProductId": "C3S80L2NKZCZ",
              "ProductKind": "Consumable",
              "LocalizedProperties": [{ "ProductTitle": "22,500 Robux for Xbox", "PublisherName": "ROBLOX" }]
            }
            """,
        [ApplicationId] = """
            {
              "ProductId": "9WZDNCRFJ3TJ",
              "ProductKind": "Application",
              "LocalizedProperties": [{ "ProductTitle": "Netflix", "PublisherName": "Netflix, Inc." }]
            }
            """,
    };

    public static string ProductsResponse(IEnumerable<string> productIds) =>
        $$"""{"Products":[{{string.Join(',', productIds.Where(Products.ContainsKey).Select(id => Products[id]))}}]}""";

    public static string StorefrontResponse(IEnumerable<string> productIds) =>
        JsonSerializer.Serialize(new
        {
            Payload = new
            {
                Products = productIds.Select(id => new { ProductId = id, IsDownloadable = Installable.Contains(id) }),
            },
        });
}
