using System.Text.Json;
using Microsoft.Extensions.Options;

namespace WinGet.RestSource.Features;

public sealed class FeaturesSourceOptions
{
    /// <summary>The DISM shim executable served at /features/shim.exe, relative to the content root.</summary>
    public string ShimPath { get; set; } = "shim/winget-feature-shim.exe";

    /// <summary>The feature catalog, relative to the content root.</summary>
    public string CatalogPath { get; set; } = "Features/catalog.json";

    /// <summary>Upper bound on results returned from /manifestSearch.</summary>
    public int MaximumResults { get; set; } = 100;
}

/// <summary>
/// One entry of the curated catalog: a DISM optional feature (<c>dism /online /get-features</c>) or a
/// capability (<c>dism /online /get-capabilities</c>). The catalog is static because features live on the
/// client, not on a server — DISM names are stable across Windows versions, and DISM itself reports
/// "unknown feature" for entries the client's build does not carry.
/// </summary>
public sealed record WindowsFeature(string Kind, string Name, string DisplayName, string Description, string? Moniker = null)
{
    public const string FeatureKind = "Feature";
    public const string CapabilityKind = "Capability";

    /// <summary>Capability names carry their version after <c>~~~~</c>, e.g. <c>OpenSSH.Client~~~~0.0.1.0</c>.</summary>
    public string BareName => Name.Split("~~~~")[0];

    public string PackageIdentifier => $"Microsoft.Windows.{Kind}.{BareName}";

    /// <summary>Optional features are not versioned; capabilities are versioned by their name suffix.</summary>
    public string Version =>
        Name.Split("~~~~") is [_, { Length: > 0 } version] ? version : "Unknown";

    /// <summary>The ARP key the shim registers, so WinGet can correlate installed features.</summary>
    public string ProductCode => $"WinGetFeature.{Kind}.{BareName}";
}

/// <summary>The curated feature catalog.</summary>
public sealed class FeatureCatalog
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public FeatureCatalog(IHostEnvironment environment, IOptions<FeaturesSourceOptions> options)
    {
        var catalogPath = Path.Combine(environment.ContentRootPath, options.Value.CatalogPath);
        Features = JsonSerializer.Deserialize<List<WindowsFeature>>(File.ReadAllBytes(catalogPath), Json) ?? [];
    }

    public IReadOnlyList<WindowsFeature> Features { get; }
}
