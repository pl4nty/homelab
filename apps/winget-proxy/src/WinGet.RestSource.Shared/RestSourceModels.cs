namespace WinGet.RestSource;

// Request and response contracts from the WinGet REST source OpenAPI spec:
// https://github.com/microsoft/winget-cli-restsource/blob/main/documentation/WinGet-1.10.0.yaml
// The union of the members the hosted sources produce or consume; null members are omitted from responses.

public sealed record Response<T>(T Data);

public sealed record InformationResponse(
    string SourceIdentifier,
    IReadOnlyList<string> ServerSupportedVersions,
    IReadOnlyList<string> UnsupportedPackageMatchFields,
    IReadOnlyList<string> UnsupportedQueryParameters,
    SourceAgreements? SourceAgreements = null);

public sealed record SourceAgreements(string AgreementsIdentifier, IReadOnlyList<AgreementDetail> Agreements);

public sealed record AgreementDetail(string AgreementLabel, string AgreementUrl);

public sealed record ManifestSearchRequest(
    int? MaximumResults = null,
    bool? FetchAllManifests = null,
    SearchRequestMatch? Query = null,
    IReadOnlyList<SearchRequestPackageMatchFilter>? Inclusions = null,
    IReadOnlyList<SearchRequestPackageMatchFilter>? Filters = null);

public sealed record SearchRequestMatch(string? KeyWord = null, string? MatchType = null);

public sealed record SearchRequestPackageMatchFilter(string? PackageMatchField = null, SearchRequestMatch? RequestMatch = null);

public sealed record ManifestSearchResponse(
    IReadOnlyList<ManifestSearchResult> Data,
    IReadOnlyList<string>? UnsupportedPackageMatchFields = null);

public sealed record ManifestSearchResult(
    string PackageIdentifier,
    string PackageName,
    string Publisher,
    IReadOnlyList<ManifestSearchVersion> Versions);

public sealed record ManifestSearchVersion(string PackageVersion, IReadOnlyList<string>? PackageFamilyNames = null);

public sealed record Manifest(string PackageIdentifier, IReadOnlyList<ManifestVersion> Versions);

public sealed record ManifestVersion(string PackageVersion, Locale DefaultLocale, IReadOnlyList<Installer> Installers);

public sealed record Locale(
    string PackageLocale,
    string Publisher,
    string PackageName,
    string License,
    string ShortDescription,
    string? PublisherUrl = null,
    string? PublisherSupportUrl = null,
    string? PackageUrl = null,
    string? LicenseUrl = null,
    string? Description = null);

public sealed record Installer(
    string InstallerType,
    string Architecture,
    string? InstallerUrl = null,
    string? InstallerSha256 = null,
    InstallerSwitches? InstallerSwitches = null,
    string? MSStoreProductIdentifier = null,
    string? PackageFamilyName = null,
    string? Scope = null,
    string? ElevationRequirement = null,
    string? ProductCode = null,
    string? ReleaseDate = null,
    IReadOnlyList<string>? Platform = null,
    IReadOnlyList<ExpectedReturnCode>? ExpectedReturnCodes = null);

public sealed record InstallerSwitches(string? Silent = null, string? SilentWithProgress = null, string? Custom = null);

public sealed record ExpectedReturnCode(long InstallerReturnCode, string ReturnResponse);
