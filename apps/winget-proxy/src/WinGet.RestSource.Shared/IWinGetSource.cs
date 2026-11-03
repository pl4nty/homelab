namespace WinGet.RestSource;

/// <summary>One WinGet REST source, hosted by the shared endpoints under its own path prefix.</summary>
public interface IWinGetSource
{
    InformationResponse Information { get; }

    Task<IReadOnlyList<ManifestSearchResult>> SearchAsync(ManifestSearchRequest request, CancellationToken cancellationToken);

    Task<Manifest?> GetManifestAsync(ManifestRequest request, CancellationToken cancellationToken);
}

/// <summary>
/// A /packageManifests request: the identifier, the honoured query parameters, and the external base URL
/// of the source's own path prefix (for manifests whose installer is served by this host).
/// </summary>
public sealed record ManifestRequest(string PackageIdentifier, string? Version, string? Market, string BaseUrl);
