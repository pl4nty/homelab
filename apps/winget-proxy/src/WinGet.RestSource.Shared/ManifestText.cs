using System.Diagnostics.CodeAnalysis;

namespace WinGet.RestSource;

/// <summary>String shaping shared by the sources when mapping upstream data into manifests.</summary>
public static class ManifestText
{
    /// <summary>Manifest strings are length limited by the spec.</summary>
    [return: NotNullIfNotNull(nameof(value))]
    public static string? Truncate(string? value, int length) =>
        value is null || value.Length <= length ? value : value[..(length - 3)] + "...";

    public static string? Coalesce(params string?[] values) =>
        values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value));

    public static string? Url(string? value) =>
        Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https" ? uri.ToString() : null;

    public static IReadOnlyList<T>? NullIfEmpty<T>(IReadOnlyList<T> values) => values.Count > 0 ? values : null;
}
