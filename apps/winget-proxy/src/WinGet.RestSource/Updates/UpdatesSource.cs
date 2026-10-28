using System.Globalization;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;
using static WinGet.RestSource.ManifestText;

namespace WinGet.RestSource.Updates;

/// <summary>
/// Translates WinGet REST source requests into Microsoft Update Catalog queries, and catalog updates into
/// WinGet manifests installed on the client by the shim executable this host also serves (which downloads
/// the .msu/.cab payload, verifies it, and hands it to wusa, DISM or pnputil).
/// </summary>
/// <remarks>
/// Each catalog row is its own package, identified by its update GUID. A KB number is also a package: the
/// catalog lists one row per architecture and per Windows release, and WinGet's search request carries no
/// architecture, so `winget install KB5078885 --architecture x64` only works if the rows are one package
/// with an installer per architecture.
/// </remarks>
public sealed partial class UpdatesSource(
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

        // A bare KB number answers with the KB package alone, so it is not ambiguous with its own rows.
        if (KbNumber().IsMatch(keyword) && KbRows(updates, keyword) is { Count: > 0 } rows)
        {
            return [.. new[] { new ManifestSearchResult(
                keyword.ToUpperInvariant(), KbName(rows[0]), "Microsoft", [new ManifestSearchVersion(Version(rows[0]))]) }
                .Where(result => Matches(result, request.Filters))];
        }

        return [.. updates.Select(ToSearchResult).Where(result => Matches(result, request.Filters)).Take(limit)];
    }

    public async Task<Manifest?> GetManifestAsync(ManifestRequest request, CancellationToken ct)
    {
        if (KbNumber().IsMatch(request.PackageIdentifier))
        {
            return await GetKbManifestAsync(request, ct);
        }

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

    /// <summary>
    /// One installer per architecture across the KB's rows. Releases that share a file (21H2 and 22H2 of
    /// Windows 10, say) collapse to it; an architecture whose releases ship different files is left out
    /// rather than guessed.
    /// </summary>
    private async Task<Manifest?> GetKbManifestAsync(ManifestRequest request, CancellationToken ct)
    {
        var kb = request.PackageIdentifier.ToUpperInvariant();
        var rows = KbRows(await catalog.SearchAsync(kb, ct), kb);
        if (rows.Count == 0 || shim.Sha256 is null || (request.Version is not null && request.Version != Version(rows[0])))
        {
            return null;
        }

        var files = await Task.WhenAll(rows.Select(async row =>
            (row, files: await catalog.GetFilesAsync(row.UpdateId, ct))));
        Installer[] installers =
        [
            .. files
                .SelectMany(update => update.files.Select(file =>
                    (file.Url, installer: ToInstaller(file, update.row, request.BaseUrl))))
                .Where(file => file.installer is not null)
                .GroupBy(file => file.installer!.Architecture)
                .Where(architecture => architecture.Select(file => file.Url).Distinct().Count() == 1)
                .Select(architecture => architecture.First().installer!),
        ];
        if (installers.Length == 0)
        {
            return null;
        }

        var description = await catalog.GetDescriptionAsync(rows[0].UpdateId, ct);
        var locale = new Locale(
            PackageLocale: "en-us",
            Publisher: "Microsoft",
            PackageName: KbName(rows[0]),
            License: "Proprietary",
            ShortDescription: Truncate(description ?? KbName(rows[0]), 256),
            PackageUrl: $"{UpdateCatalog.BaseUrl}Search.aspx?q={kb}",
            Description: Truncate(
                $"{description ?? KbName(rows[0])}\n\nUpdates:\n{string.Join('\n', rows.Select(row => row.Title))}", 10000));

        return new Manifest(kb, [new ManifestVersion(Version(rows[0]), locale, installers)]);
    }

    /// <summary>
    /// The rows a KB package installs from. Dynamic updates service setup media rather than a running
    /// system, so they stay reachable only by their own GUIDs.
    /// </summary>
    private static List<CatalogUpdate> KbRows(IEnumerable<CatalogUpdate> updates, string kb) =>
    [
        .. updates.Where(update =>
            update.Title.Contains($"({kb})", StringComparison.OrdinalIgnoreCase)
            && !update.IsDriver
            && !update.Title.Contains("Dynamic", StringComparison.OrdinalIgnoreCase)),
    ];

    /// <summary>The row's title without its release and architecture, which the KB package spans.</summary>
    private static string KbName(CatalogUpdate update) =>
        Truncate(KbNameParts().Replace(update.Title, string.Empty), 256);

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

        // The catalog publishes only a SHA-1 digest for many cumulative updates.
        var digest = !string.IsNullOrEmpty(file.Sha256) ? $"/sha256:{file.Sha256}"
            : !string.IsNullOrEmpty(file.Sha1) ? $"/sha1:{file.Sha1}"
            : null;

        if (kind is null || digest is null)
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
                Custom: $"/type:{kind} /url:{file.Url} {digest} /name:{file.FileName}" +
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

    [GeneratedRegex(@"^KB\d{6,8}$", RegexOptions.IgnoreCase)]
    private static partial Regex KbNumber();

    [GeneratedRegex(@" Version \w+| for (x86|x64|ARM64|ARM)-based Systems", RegexOptions.IgnoreCase)]
    private static partial Regex KbNameParts();
}
