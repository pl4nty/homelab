using Microsoft.Extensions.Options;

namespace WinGet.RestSource.Features;

/// <summary>
/// Serves the curated catalog of Windows optional features and capabilities as WinGet packages, with
/// installers that delegate to DISM on the client through the shim executable this host also serves.
/// </summary>
public sealed class FeaturesSource(
    FeatureCatalog catalog,
    [FromKeyedServices(FeaturesSource.ShimKey)] ShimFile shim,
    IOptions<FeaturesSourceOptions> options) : IWinGetSource
{
    public const string ShimKey = "features-shim";

    private readonly FeaturesSourceOptions _options = options.Value;

    public InformationResponse Information { get; } = new(
        SourceIdentifier: "WindowsFeatures",
        ServerSupportedVersions: ["1.0.0", "1.1.0", "1.6.0"],
        UnsupportedPackageMatchFields:
        [
            "Command", "Tag", "PackageFamilyName", "ProductCode", "UpgradeCode",
            "NormalizedPackageNameAndPublisher", "HasInstallerType",
        ],
        UnsupportedQueryParameters: ["Channel", "Market"]);

    public Task<IReadOnlyList<ManifestSearchResult>> SearchAsync(ManifestSearchRequest request, CancellationToken ct)
    {
        var limit = Math.Clamp(request.MaximumResults ?? _options.MaximumResults, 1, _options.MaximumResults);

        // Unlike a store-backed source the catalog is small and finite, so an empty query or
        // FetchAllManifests legitimately returns everything - `winget export` relies on it.
        return Task.FromResult<IReadOnlyList<ManifestSearchResult>>(
        [
            .. catalog.Features
                .Where(feature => Included(feature, request) && Filtered(feature, request.Filters))
                .Select(ToSearchResult)
                .Take(limit)
        ]);
    }

    public Task<Manifest?> GetManifestAsync(ManifestRequest request, CancellationToken ct)
    {
        var feature = catalog.Features.FirstOrDefault(feature =>
            string.Equals(feature.PackageIdentifier, request.PackageIdentifier, StringComparison.OrdinalIgnoreCase));

        return Task.FromResult(
            feature is null || (request.Version is not null && request.Version != feature.Version) || shim.Sha256 is null
                ? null
                : ToManifest(feature, request.BaseUrl));
    }

    private static ManifestSearchResult ToSearchResult(WindowsFeature feature) => new(
        feature.PackageIdentifier,
        feature.DisplayName,
        "Microsoft",
        [new ManifestSearchVersion(feature.Version)]);

    private Manifest ToManifest(WindowsFeature feature, string baseUrl)
    {
        var isCapability = feature.Kind == WindowsFeature.CapabilityKind;

        var locale = new Locale(
            PackageLocale: "en-us",
            Publisher: "Microsoft",
            PackageName: feature.DisplayName,
            License: "Proprietary",
            ShortDescription: feature.Description,
            PackageUrl: isCapability
                ? "https://learn.microsoft.com/windows-hardware/manufacture/desktop/features-on-demand-non-language-fod"
                : "https://learn.microsoft.com/windows/client-management/client-tools/add-remove-hide-features",
            Description: $"{feature.Description}\n\nThis package is the built-in Windows " +
                $"{(isCapability ? "capability" : "optional feature")} `{feature.Name}`; installing it runs " +
                $"`dism.exe /online /{(isCapability ? "add-capability /capabilityname" : "enable-feature /featurename")}:{feature.Name}`.");

        var installer = new Installer(
            InstallerType: "exe",
            Architecture: "neutral",
            InstallerUrl: $"{baseUrl}/shim.exe",
            InstallerSha256: shim.Sha256!,
            InstallerSwitches: new InstallerSwitches(
                Silent: "/quiet",
                SilentWithProgress: "/quiet",
                Custom: $"/action:enable /kind:{feature.Kind} /name:{feature.Name} " +
                        $"/version:{feature.Version} /display:\"{feature.DisplayName}\""),
            Scope: "machine",
            ElevationRequirement: "elevationRequired",
            ProductCode: feature.ProductCode,
            ExpectedReturnCodes: [new ExpectedReturnCode(3010, "rebootRequiredToFinish")]);

        return new Manifest(feature.PackageIdentifier, [new ManifestVersion(feature.Version, locale, [installer])]);
    }

    /// <summary>Inclusions (and the plain query) are ORed; a request with none of them matches everything.</summary>
    private static bool Included(WindowsFeature feature, ManifestSearchRequest request)
    {
        List<SearchRequestPackageMatchFilter> included =
        [
            .. request.Query is { KeyWord.Length: > 0 }
                ? [new SearchRequestPackageMatchFilter(null, request.Query)]
                : Array.Empty<SearchRequestPackageMatchFilter>(),
            .. request.Inclusions ?? [],
        ];

        return included.Count == 0 || included.Any(inclusion => Matches(feature, inclusion));
    }

    /// <summary>Filters are ANDed on top of the inclusions.</summary>
    private static bool Filtered(WindowsFeature feature, IReadOnlyList<SearchRequestPackageMatchFilter>? filters) =>
        filters is null || filters.All(filter => Matches(feature, filter));

    private static bool Matches(WindowsFeature feature, SearchRequestPackageMatchFilter filter)
    {
        if (filter.RequestMatch is not { KeyWord.Length: > 0 } match)
        {
            return true;
        }

        return filter.PackageMatchField switch
        {
            PackageMatchFields.PackageIdentifier => PackageMatchFields.Matches(feature.PackageIdentifier, match),
            PackageMatchFields.PackageName => PackageMatchFields.Matches(feature.DisplayName, match),
            PackageMatchFields.Moniker => PackageMatchFields.Matches(feature.Moniker ?? string.Empty, match),
            // A field-less match (the plain query) searches everything, including the DISM name.
            null => PackageMatchFields.Matches(feature.PackageIdentifier, match)
                || PackageMatchFields.Matches(feature.DisplayName, match)
                || PackageMatchFields.Matches(feature.Name, match)
                || PackageMatchFields.Matches(feature.Moniker ?? string.Empty, match),
            // Market has no meaning for on-device features; the rest are declared unsupported.
            _ => true,
        };
    }
}
