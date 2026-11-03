namespace WinGet.RestSource;

/// <summary>PackageMatchField values from the spec, and the matching helpers the sources share.</summary>
public static class PackageMatchFields
{
    public const string PackageIdentifier = nameof(PackageIdentifier);
    public const string PackageName = nameof(PackageName);
    public const string PackageFamilyName = nameof(PackageFamilyName);
    public const string Moniker = nameof(Moniker);
    public const string Market = nameof(Market);

    /// <summary>
    /// The fields from the source's unsupported list that this request actually asked to match on, or null
    /// if it asked for none. In a search response the list means "these fields of your request were
    /// ignored", so returning the whole set unconditionally tells WinGet every search was unsupported: it
    /// logs "Search request is not supported by the rest source" and drops the source from `winget upgrade`
    /// and other aggregate commands.
    /// </summary>
    public static IReadOnlyList<string>? UnsupportedIn(ManifestSearchRequest request, IReadOnlyList<string> unsupported)
    {
        string[] used =
        [
            .. (request.Inclusions ?? []).Concat(request.Filters ?? [])
                .Select(filter => filter.PackageMatchField)
                .OfType<string>()
                .Where(unsupported.Contains)
                .Distinct()
        ];

        return used.Length > 0 ? used : null;
    }

    /// <summary>Keywords a client sent for the given match fields, across both inclusions and filters.</summary>
    public static IEnumerable<string?> Values(ManifestSearchRequest request, params string[] fields) =>
        (request.Inclusions ?? []).Concat(request.Filters ?? [])
            .Where(filter => fields.Contains(filter.PackageMatchField))
            .Select(filter => filter.RequestMatch?.KeyWord);

    // Identifiers and names are matched case-insensitively, including for Exact: `winget install --id`
    // passes the identifier through as the user typed it.
    public static bool Matches(string value, SearchRequestMatch match) => match.MatchType switch
    {
        "Exact" => string.Equals(value, match.KeyWord, StringComparison.OrdinalIgnoreCase),
        "StartsWith" => value.StartsWith(match.KeyWord!, StringComparison.OrdinalIgnoreCase),
        _ => value.Contains(match.KeyWord!, StringComparison.OrdinalIgnoreCase),
    };
}
