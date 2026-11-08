using Microsoft.Extensions.Options;
using WinGet.RestSource.Xbox;
using static WinGet.RestSource.ManifestText;

namespace WinGet.RestSource.Versions;

/// <summary>
/// Serves every version of a Store app that FE3 still delivers, not only the latest, so
/// <c>winget install --version</c> can roll an MSIX app back. Package identifiers are Store product IDs.
/// </summary>
public sealed class VersionsSource(StoreCatalog catalog, StoreDelivery delivery, IOptions<VersionsSourceOptions> options)
    : IWinGetSource
{
    private const string Market = "US";

    private readonly VersionsSourceOptions _options = options.Value;

    public InformationResponse Information { get; } = new(
        SourceIdentifier: "StoreVersions",
        ServerSupportedVersions: ["1.0.0", "1.1.0", "1.6.0"],
        UnsupportedPackageMatchFields:
        [
            "Moniker", "Command", "Tag", "ProductCode", "UpgradeCode", "Market",
            "NormalizedPackageNameAndPublisher", "HasInstallerType",
        ],
        UnsupportedQueryParameters: ["Channel", "Market"],
        SourceAgreements: new SourceAgreements("StoreVersions", [
            new AgreementDetail("Terms of Transaction", "https://aka.ms/microsoft-store-terms-of-transaction")
        ]));

    public async Task<IReadOnlyList<ManifestSearchResult>> SearchAsync(ManifestSearchRequest request, CancellationToken ct)
    {
        var keyword = PackageMatchFields
            .Values(request, PackageMatchFields.PackageIdentifier, PackageMatchFields.PackageName)
            .Prepend(request.Query?.KeyWord)
            .FirstOrDefault(keyword => !string.IsNullOrWhiteSpace(keyword))?
            .Trim();

        // WinGet maps installed MSIX packages to available ones by searching for their package family name
        // alone, once per installed package. The built-in msstore source opts out of that, so inbox and
        // Store-installed apps otherwise show no source in `winget list`.
        string[] families =
        [
            .. PackageMatchFields.Values(request, PackageMatchFields.PackageFamilyName)
                .Where(family => !string.IsNullOrWhiteSpace(family))
                .Select(family => family!.Trim())
                .Distinct(StringComparer.OrdinalIgnoreCase),
        ];

        if (keyword is null && families.Length == 0)
        {
            return [];
        }

        var limit = Math.Clamp(request.MaximumResults ?? _options.MaximumResults, 1, _options.MaximumResults);
        List<string> ids = [];
        if (keyword is not null)
        {
            ids.AddRange(StoreCatalog.IsProductId(keyword.ToUpperInvariant())
                ? [keyword.ToUpperInvariant()]
                : (await catalog.SuggestAsync(keyword, Market, "Apps", "Application", ct)).Take(limit));
        }

        foreach (var family in families)
        {
            ids.AddRange(await catalog.LookupPackageFamilyAsync(family, Market, _options.LookupCacheDuration, ct));
        }

        List<ManifestSearchResult> results = [];
        foreach (var app in await AppsAsync([.. ids], ct))
        {
            // A product found by family must ship that family, or the match is not a strong one. Frameworks
            // (VCLibs, UI.Xaml, WindowsAppRuntime) are left to the sources that already version them: they install
            // side by side, the Store updates them for the apps that need them, and winget-pkgs maps their
            // Apps & Features versions differently, so correlating them here only mixes version schemes.
            if (app.Versions.Count > 0 &&
                (keyword is not null ||
                    (families.Contains(app.PackageFamilyName, StringComparer.OrdinalIgnoreCase) && !app.Product.IsFramework)))
            {
                results.Add(new ManifestSearchResult(
                    app.Product.ProductId,
                    Title(app.Product),
                    Publisher(app.Product),
                    [.. app.Versions.Select(version => new ManifestSearchVersion(version.Key, [app.PackageFamilyName]))]));
            }
        }

        return results;
    }

    public async Task<Manifest?> GetManifestAsync(ManifestRequest request, CancellationToken ct)
    {
        var app = (await AppsAsync([request.PackageIdentifier.ToUpperInvariant()], ct)).FirstOrDefault();
        var latest = app?.Versions.FirstOrDefault()?.Key;
        var versions = app?.Versions
            .Where(version => request.Version is null || version.Key == request.Version)
            .ToArray();

        if (app is null || versions is not { Length: > 0 })
        {
            return null;
        }

        // FE3 signs each URL for minutes, so they are fetched for every manifest request rather than cached.
        // The latest version installs through the Store, so it needs none.
        var pinned = versions.Where(version => version.Key != latest).ToArray();
        var urls = pinned.Length > 0
            ? await delivery.GetFileUrlsAsync(pinned.SelectMany(version => version), ct)
            : new Dictionary<string, string>();

        ManifestVersion[] manifestVersions =
        [
            .. versions
                .Select(version => new ManifestVersion(
                    version.Key,
                    Locale(app.Product),
                    version.Key == latest
                        ? [StoreInstaller(app, version)]
                        : [.. version.Select(package => ToInstaller(package, urls)).OfType<Installer>().DistinctBy(installer => installer.Architecture)]))
                .Where(version => version.Installers.Count > 0),
        ];

        return manifestVersions.Length > 0 ? new Manifest(app.Product.ProductId, manifestVersions) : null;
    }

    /// <summary>
    /// The latest version is handed to the Store client, as the msstore source does: the Store resolves framework
    /// dependencies and picks the package for the device, which the bare FE3 files leave to the caller. The
    /// version is still FE3's, so `winget upgrade` can compare it with what is installed.
    /// </summary>
    private static Installer StoreInstaller(StoreApp app, IGrouping<string, DeliveryPackage> version) => new(
        InstallerType: "msstore",
        Architecture: "neutral",
        MSStoreProductIdentifier: app.Product.ProductId,
        PackageFamilyName: app.PackageFamilyName,
        Scope: "user",
        ReleaseDate: version.Max(package => package.Modified)?.ToString("yyyy-MM-dd"),
        MinimumOSVersion: MinimumOSVersion(version));

    private static string? MinimumOSVersion(IEnumerable<DeliveryPackage> packages) => packages
        .Select(package => System.Version.TryParse(package.MinimumOSVersion, out var parsed) ? parsed : null)
        .OfType<System.Version>()
        .DefaultIfEmpty()
        .Min()?
        .ToString();

    /// <summary>The products' own packages, grouped by version, newest first. Dependencies and encrypted packages are left out.</summary>
    private async Task<IReadOnlyList<StoreApp>> AppsAsync(string[] productIds, CancellationToken ct)
    {
        string[] ids = [.. productIds.Where(StoreCatalog.IsProductId).Distinct()];
        if (ids.Length == 0)
        {
            return [];
        }

        List<StoreApp> apps = [];
        foreach (var product in await catalog.GetProductsAsync(ids, Market, ct))
        {
            var fulfillment = product.DisplaySkuAvailabilities?
                .SelectMany(availability => availability.Sku?.Properties?.Packages ?? [])
                .Select(package => package.FulfillmentData)
                .FirstOrDefault(data => data?.WuCategoryId is not null);

            // Win32 listings have no category: FE3 does not deliver them.
            if (fulfillment?.WuCategoryId is null || fulfillment.PackageFamilyName is null)
            {
                continue;
            }

            var packages = await delivery.GetPackagesAsync(fulfillment.WuCategoryId, ct);

            apps.Add(new StoreApp(
                product,
                fulfillment.PackageFamilyName,
                [
                    .. packages
                        .Where(package => !package.IsEncrypted && package.TargetsDesktop &&
                            string.Equals(package.PackageFamilyName, fulfillment.PackageFamilyName, StringComparison.OrdinalIgnoreCase))
                        .GroupBy(package => package.PackageVersion)
                        .OrderByDescending(version => System.Version.TryParse(version.Key, out var parsed) ? parsed : new System.Version()),
                ]));
        }

        return apps;
    }

    private static Installer? ToInstaller(DeliveryPackage package, IReadOnlyDictionary<string, string> urls) =>
        package.Sha1Digest is not null && urls.TryGetValue(package.Sha1Digest, out var url)
            ? new Installer(
                InstallerType: package.FileExtension.Contains("msix") ? "msix" : "appx",
                Architecture: package.Architecture.ToLowerInvariant(),
                InstallerUrl: url,
                InstallerSha256: package.Sha256,
                PackageFamilyName: package.PackageFamilyName,
                ReleaseDate: package.Modified?.ToString("yyyy-MM-dd"),
                MinimumOSVersion: package.MinimumOSVersion)
            : null;

    private static Locale Locale(CatalogProduct product)
    {
        var localized = product.LocalizedProperties?.FirstOrDefault();

        return new Locale(
            PackageLocale: localized?.Language ?? "en-us",
            Publisher: Publisher(product),
            PackageName: Title(product),
            License: "Proprietary",
            ShortDescription: Truncate(
                Coalesce(localized?.ShortDescription, localized?.ProductDescription) ?? Title(product), 256),
            PublisherUrl: Url(localized?.PublisherWebsiteUri),
            PublisherSupportUrl: Url(localized?.SupportUri),
            PackageUrl: $"https://apps.microsoft.com/detail/{product.ProductId}",
            LicenseUrl: "https://www.microsoft.com/useterms",
            Description: Truncate(localized?.ProductDescription, 10000));
    }

    private static string Title(CatalogProduct product) => Truncate(
        Coalesce(product.LocalizedProperties?.FirstOrDefault()?.ProductTitle, product.LocalizedProperties?.FirstOrDefault()?.ShortTitle)
        ?? product.ProductId, 256);

    private static string Publisher(CatalogProduct product) => Truncate(
        Coalesce(product.LocalizedProperties?.FirstOrDefault()?.PublisherName, product.LocalizedProperties?.FirstOrDefault()?.DeveloperName)
        ?? "Unknown", 256);

    private sealed record StoreApp(CatalogProduct Product, string PackageFamilyName, IReadOnlyList<IGrouping<string, DeliveryPackage>> Versions);
}
