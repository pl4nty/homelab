using Microsoft.Extensions.Options;
using static WinGet.RestSource.ManifestText;

namespace WinGet.RestSource.Xbox;

/// <summary>
/// Translates WinGet REST source requests into Microsoft Store display catalog queries,
/// and catalog products into WinGet manifests installed through the Store (<c>msstore</c> installer type).
/// </summary>
public sealed class XboxSource(StoreCatalog catalog, IOptions<XboxSourceOptions> options) : IWinGetSource
{
    private readonly XboxSourceOptions _options = options.Value;

    public InformationResponse Information { get; } = new(
        SourceIdentifier: "XboxStore",
        ServerSupportedVersions: ["1.0.0", "1.1.0", "1.6.0"],
        UnsupportedPackageMatchFields:
        [
            "Moniker", "Command", "Tag", "ProductCode", "UpgradeCode",
            "NormalizedPackageNameAndPublisher", "HasInstallerType",
        ],
        UnsupportedQueryParameters: ["Channel"],
        SourceAgreements: new SourceAgreements("XboxStore", [
            new AgreementDetail("Terms of Transaction", "https://aka.ms/microsoft-store-terms-of-transaction")
        ]));

    public async Task<IReadOnlyList<ManifestSearchResult>> SearchAsync(ManifestSearchRequest request, CancellationToken ct)
    {
        var keyword = PackageMatchFields
            .Values(request, PackageMatchFields.PackageIdentifier, PackageMatchFields.PackageName)
            .Prepend(request.Query?.KeyWord)
            .FirstOrDefault(keyword => !string.IsNullOrWhiteSpace(keyword))?
            .Trim();

        if (keyword is null)
        {
            // FetchAllManifests and empty queries would mean enumerating the whole store catalog.
            return [];
        }

        var market = Market(PackageMatchFields.Values(request, PackageMatchFields.Market).FirstOrDefault());
        var limit = Math.Clamp(request.MaximumResults ?? _options.MaximumResults, 1, _options.MaximumResults);

        // `winget install --id` sends a store ID, which the catalog can be asked about directly.
        var products = await GamesAsync(
            StoreCatalog.IsProductId(keyword.ToUpperInvariant())
                ? [keyword.ToUpperInvariant()]
                : await catalog.SuggestAsync(keyword, market, ct),
            market, limit, ct);

        return [.. products.Select(ToSearchResult).Where(result => Matches(result, request.Filters)).Take(limit)];
    }

    public async Task<Manifest?> GetManifestAsync(ManifestRequest request, CancellationToken ct)
    {
        var products = await GamesAsync([request.PackageIdentifier.ToUpperInvariant()], Market(request.Market), 1, ct);
        var product = products.FirstOrDefault();

        return product is null || (request.Version is not null && request.Version != Version(product))
            ? null
            : ToManifest(product);
    }

    /// <summary>Catalog details for the given store IDs, narrowed to games the Store will install on this device family.</summary>
    private async Task<IReadOnlyList<CatalogProduct>> GamesAsync(
        IEnumerable<string> productIds, string market, int limit, CancellationToken ct)
    {
        string[] ids = [.. productIds.Where(StoreCatalog.IsProductId).Distinct()];
        if (ids.Length == 0)
        {
            return [];
        }

        var installable = await catalog.GetInstallableAsync(ids, market, ct);

        string[] wanted = [.. ids.Where(installable.Contains).Take(limit)];
        if (wanted.Length == 0)
        {
            return [];
        }

        var products = await catalog.GetProductsAsync(wanted, market, ct);

        return [.. products.Where(product => product.IsGame)];
    }

    private static ManifestSearchResult ToSearchResult(CatalogProduct product) => new(
        product.ProductId,
        Title(product),
        Publisher(product),
        [new ManifestSearchVersion(Version(product), PackageFamilyNames(product))]);

    private Manifest ToManifest(CatalogProduct product)
    {
        var localized = Localized(product);

        var locale = new Locale(
            PackageLocale: localized?.Language ?? _options.Language,
            Publisher: Publisher(product),
            PackageName: Title(product),
            License: "Proprietary",
            ShortDescription: Truncate(
                Coalesce(localized?.ShortDescription, localized?.ProductDescription) ?? Title(product), 256),
            PublisherUrl: Url(localized?.PublisherWebsiteUri),
            PublisherSupportUrl: Url(localized?.SupportUri),
            PackageUrl: $"https://www.xbox.com/games/store/-/{product.ProductId}",
            LicenseUrl: "https://www.microsoft.com/useterms",
            Description: Truncate(localized?.ProductDescription, 10000));

        var installer = new Installer(
            InstallerType: "msstore",
            Architecture: "neutral",
            MSStoreProductIdentifier: product.ProductId,
            PackageFamilyName: PackageFamilyNames(product)?.FirstOrDefault(),
            Scope: "user",
            ReleaseDate: product.MarketProperties?.FirstOrDefault()?.OriginalReleaseDate?.ToString("yyyy-MM-dd"),
            Platform: Platforms(product));

        return new Manifest(product.ProductId, [new ManifestVersion(Version(product), locale, [installer])]);
    }

    private static LocalizedProperties? Localized(CatalogProduct product) => product.LocalizedProperties?.FirstOrDefault();

    private static string Title(CatalogProduct product) =>
        Truncate(Coalesce(Localized(product)?.ProductTitle, Localized(product)?.ShortTitle) ?? product.ProductId, 256);

    private static string Publisher(CatalogProduct product) =>
        Truncate(Coalesce(Localized(product)?.PublisherName, Localized(product)?.DeveloperName) ?? "Unknown", 256);

    /// <summary>The catalog does not version games, so most titles report <c>Unknown</c>.</summary>
    private static string Version(CatalogProduct product) =>
        Skus(product).Select(sku => sku.VersionString).FirstOrDefault(version => !string.IsNullOrWhiteSpace(version))
        ?? "Unknown";

    private static IEnumerable<SkuProperties> Skus(CatalogProduct product) =>
        (product.DisplaySkuAvailabilities ?? []).Select(availability => availability.Sku?.Properties).OfType<SkuProperties>();

    private static IEnumerable<SkuPackage> Packages(CatalogProduct product) =>
        Skus(product).SelectMany(sku => sku.Packages ?? []);

    private static IReadOnlyList<string>? PackageFamilyNames(CatalogProduct product) => NullIfEmpty(
    [
        .. Packages(product)
            .Select(package => package.FulfillmentData?.PackageFamilyName)
            .Prepend(product.Properties?.PackageFamilyName)
            .Where(name => !string.IsNullOrEmpty(name))
            .OfType<string>()
            .Distinct()
    ]);

    /// <summary>Console-only titles have no WinGet platform; Play Anywhere titles carry a Windows package.</summary>
    private static IReadOnlyList<string>? Platforms(CatalogProduct product) => NullIfEmpty(
    [
        .. Packages(product)
            .SelectMany(package => package.PlatformDependencies ?? [])
            .Select(dependency => dependency.PlatformName)
            .Where(platform => platform is "Windows.Desktop" or "Windows.Universal")
            .OfType<string>()
            .Distinct()
    ]);

    private string Market(string? market) =>
        market is { Length: 2 } ? market.ToUpperInvariant() : _options.DefaultMarket;

    private static bool Matches(ManifestSearchResult result, IReadOnlyList<SearchRequestPackageMatchFilter>? filters) =>
        filters is null || filters.All(filter =>
            filter.RequestMatch is not { KeyWord.Length: > 0 } match || filter.PackageMatchField switch
            {
                PackageMatchFields.PackageIdentifier => PackageMatchFields.Matches(result.PackageIdentifier, match),
                PackageMatchFields.PackageName => PackageMatchFields.Matches(result.PackageName, match),
                PackageMatchFields.PackageFamilyName => (result.Versions[0].PackageFamilyNames ?? [])
                    .Any(name => PackageMatchFields.Matches(name, match)),
                // Market is applied by querying the storefront; the rest are declared unsupported.
                _ => true,
            });
}
