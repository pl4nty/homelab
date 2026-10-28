using System.Globalization;
using Microsoft.Extensions.Options;
using static WinGet.RestSource.ManifestText;

namespace WinGet.RestSource.Updates;

/// <summary>
/// Translates WinGet REST source requests into Microsoft Update Catalog queries, and catalog updates into
/// WinGet manifests installed on the client by the shim executable this host also serves (which downloads
/// the .msu/.cab payload, verifies it, and hands it to wusa, DISM or pnputil).
/// </summary>
public sealed class UpdatesSource(
    UpdateCatalog catalog,
    [FromKeyedServices(UpdatesSource.ShimKey)] ShimFile shim,
    IOptions<UpdatesSourceOptions> options) : IWinGetSource
{
    public const string ShimKey = "updates-shim";

    private readonly UpdatesSourceOptions _options = options.Value;

    public InformationResponse Information { get; } = new(
        SourceIdentifier: "WindowsUpdateCatalog",
        ServerSupportedVersions: ["1.0.0", "1.1.0", "1.6.0"],
        UnsupportedPackageMatchFields:
        [
            "Moniker", "Command", "Tag", "PackageFamilyName", "ProductCode", "UpgradeCode",
            "NormalizedPackageNameAndPublisher", "HasInstallerType",
        ],
        UnsupportedQueryParameters: ["Channel", "Market"]);

    public async Task<IReadOnlyList<ManifestSearchResult>> SearchAsync(ManifestSearchRequest request, CancellationToken ct)
    {
        var keyword = PackageMatchFields
            .Values(request, PackageMatchFields.PackageIdentifier, PackageMatchFields.PackageName)
            .Prepend(request.Query?.KeyWord)
            .FirstOrDefault(keyword => !string.IsNullOrWhiteSpace(keyword))?
            .Trim();

        if (keyword is null)
        {
            // FetchAllManifests and empty queries would mean enumerating the whole update catalog.
            return [];
        }

        var limit = Math.Clamp(request.MaximumResults ?? _options.MaximumResults, 1, _options.MaximumResults);
        var updates = await catalog.SearchAsync(keyword, ct);

        return [.. updates.Select(ToSearchResult).Where(result => Matches(result, request.Filters)).Take(limit)];
    }

    public async Task<Manifest?> GetManifestAsync(ManifestRequest request, CancellationToken ct)
    {
        if (!UpdateCatalog.IsUpdateId(request.PackageIdentifier) || shim.Sha256 is null)
        {
            return null;
        }

        // The catalog resolves a bare update GUID to its single search row.
        var updates = await catalog.SearchAsync(request.PackageIdentifier.ToLowerInvariant(), ct);
        var update = updates.FirstOrDefault(update =>
            string.Equals(update.UpdateId, request.PackageIdentifier, StringComparison.OrdinalIgnoreCase));

        if (update is null || (request.Version is not null && request.Version != Version(update)))
        {
            return null;
        }

        var files = await catalog.GetFilesAsync(update.UpdateId, ct);
        Installer[] installers = [.. files.Select(file => ToInstaller(file, update, request.BaseUrl)).OfType<Installer>()];
        if (installers.Length == 0)
        {
            // Nothing the shim can install (e.g. a self-extracting .exe payload, or no published digest).
            return null;
        }

        var description = await catalog.GetDescriptionAsync(update.UpdateId, ct);
        var locale = new Locale(
            PackageLocale: "en-us",
            Publisher: "Microsoft",
            PackageName: Truncate(update.Title, 256),
            License: "Proprietary",
            ShortDescription: Truncate(description ?? update.Title, 256),
            PackageUrl: $"{UpdateCatalog.BaseUrl}ScopedViewInline.aspx?updateid={update.UpdateId}",
            Description: Truncate(
                $"{description ?? update.Title}\n\nProducts: {update.Products}\nClassification: {update.Classification}", 10000));

        return new Manifest(update.UpdateId, [new ManifestVersion(Version(update), locale, installers)]);
    }

    private static ManifestSearchResult ToSearchResult(CatalogUpdate update) => new(
        update.UpdateId,
        Truncate(update.Title, 256),
        "Microsoft",
        [new ManifestSearchVersion(Version(update))]);

    /// <summary>
    /// One installer per catalog file the shim knows how to install: .msu (wusa), .cab (DISM), and driver
    /// .cab (pnputil). The installer WinGet downloads and hash-checks is the shim itself; the payload's URL
    /// and catalog SHA-256 travel in the custom switches, and the shim verifies the payload before installing.
    /// </summary>
    private Installer? ToInstaller(UpdateFile file, CatalogUpdate update, string baseUrl)
    {
        var kind = Path.GetExtension(file.FileName).ToLowerInvariant() switch
        {
            ".msu" => "msu",
            ".cab" => "cab",
            _ => null,
        };

        if (kind is null || string.IsNullOrEmpty(file.Sha256))
        {
            return null;
        }

        return new Installer(
            InstallerType: "exe",
            Architecture: Architecture(file.FileName),
            InstallerUrl: $"{baseUrl}/shim.exe",
            InstallerSha256: shim.Sha256!,
            InstallerSwitches: new InstallerSwitches(
                Silent: "/quiet",
                SilentWithProgress: "/quiet",
                Custom: $"/type:{kind} /url:{file.Url} /sha256:{file.Sha256} /name:{file.FileName}" +
                        (update.IsDriver ? " /driver" : string.Empty)),
            Scope: "machine",
            ElevationRequirement: "elevationRequired",
            ReleaseDate: ReleaseDate(update.LastUpdated),
            ExpectedReturnCodes:
            [
                new ExpectedReturnCode(3010, "rebootRequiredToFinish"),
                new ExpectedReturnCode(2359302, "alreadyInstalled"), // WU_S_ALREADY_INSTALLED from wusa
            ]);
    }

    /// <summary>Most patches have no catalog version (the KB stays in the title); drivers usually do.</summary>
    private static string Version(CatalogUpdate update) =>
        update.Version is { Length: > 0 } version && !version.Equals("n/a", StringComparison.OrdinalIgnoreCase)
            ? version
            : "Unknown";

    private static string Architecture(string fileName) => fileName.ToLowerInvariant() switch
    {
        var name when name.Contains("arm64") => "arm64",
        var name when name.Contains("x64") || name.Contains("amd64") => "x64",
        var name when name.Contains("x86") => "x86",
        _ => "neutral",
    };

    private static string? ReleaseDate(string lastUpdated) =>
        DateTime.TryParseExact(lastUpdated, "M/d/yyyy", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date)
            ? date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)
            : null;

    private static bool Matches(ManifestSearchResult result, IReadOnlyList<SearchRequestPackageMatchFilter>? filters) =>
        filters is null || filters.All(filter =>
            filter.RequestMatch is not { KeyWord.Length: > 0 } match || filter.PackageMatchField switch
            {
                PackageMatchFields.PackageIdentifier => PackageMatchFields.Matches(result.PackageIdentifier, match),
                PackageMatchFields.PackageName => PackageMatchFields.Matches(result.PackageName, match),
                // Market has no meaning for the catalog; the rest are declared unsupported.
                _ => true,
            });
}
