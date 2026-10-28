using System.Net;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;

namespace WinGet.RestSource.Updates;

public sealed class UpdatesSourceOptions
{
    /// <summary>The install shim executable served at /updatecatalog/shim.exe, relative to the content root.</summary>
    public string ShimPath { get; set; } = "shim/winget-update-shim.exe";

    /// <summary>Upper bound on results returned from /manifestSearch.</summary>
    public int MaximumResults { get; set; } = 25;

    /// <summary>How long catalog responses are reused.</summary>
    public TimeSpan CacheDuration { get; set; } = TimeSpan.FromHours(1);
}

/// <summary>
/// Client for the public Microsoft Update Catalog (catalog.update.microsoft.com). The catalog has no JSON
/// API, so this scrapes the same three pages the website itself uses: the search results table, the
/// download dialog (which carries direct file URLs and their SHA-256 digests), and the details view.
/// </summary>
public sealed partial class UpdateCatalog(HttpClient http, IMemoryCache cache, IOptions<UpdatesSourceOptions> options)
{
    public const string BaseUrl = "https://www.catalog.update.microsoft.com/";

    private readonly UpdatesSourceOptions _options = options.Value;

    public static bool IsUpdateId(string? value) => Guid.TryParseExact(value, "D", out _);

    /// <summary>
    /// Search results, in catalog order (first page only, at most 25). The catalog also resolves a bare
    /// update GUID to its single row, which is what serves `winget install --id`.
    /// </summary>
    public async Task<IReadOnlyList<CatalogUpdate>> SearchAsync(string query, CancellationToken ct)
    {
        var url = $"{BaseUrl}Search.aspx?q={Uri.EscapeDataString(query)}";
        var html = await GetCachedAsync(url, token => http.GetStringAsync(url, token), ct);

        return
        [
            .. RowRegex().Matches(html).Select(row =>
            {
                var cells = CellRegex().Matches(row.Groups["row"].Value)
                    .ToDictionary(cell => cell.Groups["column"].Value, cell => Text(cell.Groups["content"].Value));

                return new CatalogUpdate(
                    UpdateId: row.Groups["id"].Value.ToLowerInvariant(),
                    Title: cells.GetValueOrDefault("1", string.Empty),
                    Products: cells.GetValueOrDefault("2", string.Empty),
                    Classification: cells.GetValueOrDefault("3", string.Empty),
                    LastUpdated: cells.GetValueOrDefault("4", string.Empty),
                    Version: cells.GetValueOrDefault("5", string.Empty));
            })
        ];
    }

    /// <summary>
    /// The files behind an update, with the direct download URL and the digests the catalog reports. Large
    /// cumulative updates often carry only the base64 SHA-1 <c>digest</c>, with an empty <c>sha256</c>.
    /// </summary>
    public async Task<IReadOnlyList<UpdateFile>> GetFilesAsync(string updateId, CancellationToken ct)
    {
        var response = await GetCachedAsync($"download:{updateId}", async token =>
        {
            using var content = new FormUrlEncodedContent(
            [
                new KeyValuePair<string, string>(
                    "updateIDs", $"[{{\"size\":0,\"languages\":\"\",\"uidInfo\":\"{updateId}\",\"updateID\":\"{updateId}\"}}]"),
            ]);
            using var reply = await http.PostAsync($"{BaseUrl}DownloadDialog.aspx", content, token);
            reply.EnsureSuccessStatusCode();

            return await reply.Content.ReadAsStringAsync(token);
        }, ct);

        return
        [
            .. FileRegex().Matches(response)
                .GroupBy(match => match.Groups["index"].Value)
                .Select(file =>
                {
                    var values = file.ToDictionary(m => m.Groups["key"].Value, m => m.Groups["value"].Value);
                    var url = values.GetValueOrDefault("url");

                    return url is null ? null : new UpdateFile(
                        Url: url,
                        FileName: values.GetValueOrDefault("fileName") is { Length: > 0 } name
                            ? name
                            : url.Split('/')[^1],
                        Sha256: values.GetValueOrDefault("sha256"),
                        Sha1: values.GetValueOrDefault("digest"));
                })
                .OfType<UpdateFile>()
        ];
    }

    /// <summary>The description text from the update's details view, or null.</summary>
    public async Task<string?> GetDescriptionAsync(string updateId, CancellationToken ct)
    {
        var url = $"{BaseUrl}ScopedViewInline.aspx?updateid={Uri.EscapeDataString(updateId)}";
        var html = await GetCachedAsync(url, token => http.GetStringAsync(url, token), ct);

        return DescriptionRegex().Match(html) is { Success: true } match ? Text(match.Groups["text"].Value) : null;
    }

    private Task<string> GetCachedAsync(string cacheKey, Func<CancellationToken, Task<string>> get, CancellationToken ct) =>
        cache.GetOrCreateAsync(cacheKey, entry =>
        {
            entry.AbsoluteExpirationRelativeToNow = _options.CacheDuration;
            return get(ct);
        })!;

    private static string Text(string html) =>
        Whitespace().Replace(WebUtility.HtmlDecode(Tags().Replace(html, string.Empty)), " ").Trim();

    [GeneratedRegex("""<tr id="(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_R\d+">(?<row>.*?)</tr>""",
        RegexOptions.Singleline | RegexOptions.IgnoreCase)]
    private static partial Regex RowRegex();

    [GeneratedRegex("""<td[^>]*id="[0-9a-f-]{36}_C(?<column>\d+)_R\d+"[^>]*>(?<content>.*?)</td>""",
        RegexOptions.Singleline | RegexOptions.IgnoreCase)]
    private static partial Regex CellRegex();

    [GeneratedRegex(@"files\[(?<index>\d+)\]\.(?<key>url|fileName|sha256|digest) = '(?<value>[^']*)'")]
    private static partial Regex FileRegex();

    [GeneratedRegex("""<span id="ScopedViewHandler_desc"[^>]*>(?<text>.*?)</span>""", RegexOptions.Singleline)]
    private static partial Regex DescriptionRegex();

    [GeneratedRegex("<[^>]+>", RegexOptions.Singleline)]
    private static partial Regex Tags();

    [GeneratedRegex(@"\s+")]
    private static partial Regex Whitespace();
}

public sealed record CatalogUpdate(
    string UpdateId,
    string Title,
    string Products,
    string Classification,
    string LastUpdated,
    string Version)
{
    public bool IsDriver => Classification == "Drivers";
}

public sealed record UpdateFile(string Url, string FileName, string? Sha256, string? Sha1 = null);
