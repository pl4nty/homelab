using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;

namespace WinGet.RestSource.Xbox;

public sealed class XboxSourceOptions
{
    /// <summary>Storefront to query when the client does not ask for one.</summary>
    public string DefaultMarket { get; set; } = "US";

    /// <summary>Language used for titles and descriptions.</summary>
    public string Language { get; set; } = "en-us";

    /// <summary>
    /// Device family a title must be installable on to be served. The default excludes console-only games,
    /// which the Store cannot install from a PC.
    /// </summary>
    public string DeviceFamily { get; set; } = "Windows.Desktop";

    /// <summary>Upper bound on results returned from /manifestSearch.</summary>
    public int MaximumResults { get; set; } = 25;

    /// <summary>How long catalog responses are reused.</summary>
    public TimeSpan CacheDuration { get; set; } = TimeSpan.FromMinutes(15);
}

/// <summary>
/// Client for the public Store services: the display catalog behind the Xbox store (restricted to the Games
/// product family), and the storefront behind the Store client and the <c>msstore</c> source, which answers
/// per device family and so tells console-only titles apart from ones the Store will install on a PC.
/// </summary>
public sealed class StoreCatalog(HttpClient http, IMemoryCache cache, IOptions<XboxSourceOptions> options)
{
    public const string Catalog = "https://displaycatalog.mp.microsoft.com/v7.0/";
    public const string Storefront = "https://storeedgefd.dsx.mp.microsoft.com/v9.0/";

    // Store IDs ("big IDs") are 12 character base36 identifiers, e.g. BQ1TN1T79V9K.
    private static readonly System.Buffers.SearchValues<char> IdChars =
        System.Buffers.SearchValues.Create("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ");

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly XboxSourceOptions _options = options.Value;

    public static bool IsProductId(string? value) =>
        value is { Length: 12 } && !value.AsSpan().ContainsAnyExcept(IdChars);

    /// <summary>
    /// Title search within one product family; returns the product IDs of the given product type, best match first.
    /// The Games family also carries add-ons and currency packs, so the type keeps base games only.
    /// </summary>
    public async Task<IReadOnlyList<string>> SuggestAsync(
        string query, string market, string family, string type, CancellationToken ct)
    {
        var url = $"{Catalog}productFamilies/autosuggest?market={Uri.EscapeDataString(market)}" +
                  $"&languages={Uri.EscapeDataString(_options.Language)}" +
                  $"&query={Uri.EscapeDataString(query)}&productFamilyNames={Uri.EscapeDataString(family)}";

        var response = await SendAsync<AutoSuggestResponse>(url, token => http.GetAsync(url, token), ct);

        return response?.Results?
            .SelectMany(group => group.Products ?? [])
            .Where(product => product.Type == type)
            .Select(product => product.ProductId)
            .Distinct()
            .ToArray() ?? [];
    }

    /// <summary>Narrows the given store IDs to the ones installable on the configured device family.</summary>
    public async Task<IReadOnlySet<string>> GetInstallableAsync(
        string[] productIds, string market, CancellationToken ct)
    {
        var url = $"{Storefront}products?market={Uri.EscapeDataString(market)}" +
                  $"&locale={Uri.EscapeDataString(_options.Language)}" +
                  $"&deviceFamily={Uri.EscapeDataString(_options.DeviceFamily)}";

        var response = await SendAsync<StorefrontResponse>(
            $"{url}&ids={string.Join(',', productIds)}",
            token => http.PostAsJsonAsync(url, new { productIds }, token),
            ct);

        return (response?.Payload?.Products ?? [])
            .Where(product => product.IsDownloadable == true)
            .Select(product => product.ProductId)
            .ToHashSet();
    }

    /// <summary>Full product details for up to a few dozen store IDs.</summary>
    public async Task<IReadOnlyList<CatalogProduct>> GetProductsAsync(
        string[] productIds, string market, CancellationToken ct)
    {
        var url = $"{Catalog}products?bigIds={string.Join(',', productIds)}" +
                  $"&market={Uri.EscapeDataString(market)}" +
                  $"&languages={Uri.EscapeDataString(_options.Language)}&fieldsTemplate=Details";

        var response = await SendAsync<CatalogResponse>(url, token => http.GetAsync(url, token), ct);

        // Preserve the order the caller asked for (the catalog does not).
        return [.. (response?.Products ?? []).OrderBy(product => Array.IndexOf(productIds, product.ProductId))];
    }

    private Task<T?> SendAsync<T>(string cacheKey, Func<CancellationToken, Task<HttpResponseMessage>> send, CancellationToken ct) =>
        cache.GetOrCreateAsync(cacheKey, async entry =>
        {
            entry.AbsoluteExpirationRelativeToNow = _options.CacheDuration;

            using var response = await send(ct);
            if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.BadRequest)
            {
                return default;
            }

            response.EnsureSuccessStatusCode();
            return await response.Content.ReadFromJsonAsync<T>(Json, ct);
        })!;
}

public sealed record AutoSuggestResponse(IReadOnlyList<SuggestGroup>? Results);

public sealed record SuggestGroup(IReadOnlyList<SuggestProduct>? Products);

public sealed record SuggestProduct(string ProductId, string? Type);

public sealed record StorefrontResponse(StorefrontPayload? Payload);

public sealed record StorefrontPayload(IReadOnlyList<StorefrontProduct>? Products);

public sealed record StorefrontProduct(string ProductId, bool? IsDownloadable);

public sealed record CatalogResponse(IReadOnlyList<CatalogProduct>? Products);

public sealed record CatalogProduct(
    string ProductId,
    string? ProductKind,
    IReadOnlyList<LocalizedProperties>? LocalizedProperties,
    IReadOnlyList<MarketProperties>? MarketProperties,
    ProductProperties? Properties,
    IReadOnlyList<DisplaySkuAvailability>? DisplaySkuAvailabilities)
{
    /// <summary>The Games family also carries add-ons, bundles and currency, which are not installable packages.</summary>
    public bool IsGame => ProductKind == "Game";
}

public sealed record LocalizedProperties(
    string? ProductTitle,
    string? ShortTitle,
    string? PublisherName,
    string? DeveloperName,
    string? PublisherWebsiteUri,
    string? SupportUri,
    string? ShortDescription,
    string? ProductDescription,
    string? Language);

public sealed record MarketProperties(DateTimeOffset? OriginalReleaseDate);

public sealed record ProductProperties(string? PackageFamilyName);

public sealed record DisplaySkuAvailability(Sku? Sku);

public sealed record Sku(SkuProperties? Properties);

public sealed record SkuProperties(string? VersionString, IReadOnlyList<SkuPackage>? Packages);

public sealed record SkuPackage(IReadOnlyList<PlatformDependency>? PlatformDependencies, FulfillmentData? FulfillmentData);

public sealed record PlatformDependency(string? PlatformName);

public sealed record FulfillmentData(string? PackageFamilyName, string? WuCategoryId = null);
