using System.Data.Common;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Threading.RateLimiting;
using DuckDB.NET.Data;
using Microsoft.Extensions.Options;
using MsftUpdates.Catalog;
using MsftUpdates.Sync;

namespace MsftUpdates.Query;

public sealed class QueryOptions
{
    public int MaxRows { get; set; } = 100_000;

    /// <summary>Results are buffered before they're serialized, so this bounds the memory one query can hold.</summary>
    public long MaxBytes { get; set; } = 64L << 20;

    public TimeSpan Timeout { get; set; } = TimeSpan.FromMinutes(2);

    public int MaxConcurrency { get; set; } = 2;

    public int RequestsPerMinute { get; set; } = 60;
}

public static class QueryEndpoints
{
    public static void MapQuery(this WebApplication app)
    {
        var options = app.Services.GetRequiredService<IOptions<QueryOptions>>().Value;
        var slots = new SemaphoreSlim(options.MaxConcurrency);

        // the DuckDB httpserver extension's protocol: SQL as the body, results as JSONEachRow or JSONCompact
        app.MapPost("/query", async (HttpRequest request, CatalogStore store, CancellationToken ct) =>
        {
            using var body = new StreamReader(request.Body, Encoding.UTF8);
            return await RunAsync(await body.ReadToEndAsync(ct), request, store, options, slots, ct);
        }).RequireRateLimiting(RateLimit);

        app.MapGet("/status", (SyncStatus status) => Results.Json(status, JsonSerializerOptions.Default)).CacheControl("no-store");

        // the parts as-is, so DuckDB and other Parquet readers can query the catalog remotely
        app.MapGet("/files", (CatalogStore store) => Results.Json(
            Directory.Exists(store.DataPath)
                ? Directory.EnumerateFiles(store.DataPath, "*.parquet", SearchOption.AllDirectories)
                    .Select(f => Path.GetRelativePath(store.DataPath, f)).Order().ToArray()
                : Array.Empty<string>())).CacheControl("public, max-age=60");
        app.MapGet("/files/{**path}", (string path, CatalogStore store) =>
        {
            var full = Path.GetFullPath(Path.Combine(store.DataPath, path));
            return full.StartsWith(Path.GetFullPath(store.DataPath) + Path.DirectorySeparatorChar, StringComparison.Ordinal)
                && full.EndsWith(".parquet", StringComparison.Ordinal) && File.Exists(full)
                ? Results.File(full, "application/vnd.apache.parquet", enableRangeProcessing: true)
                : Results.NotFound();
        }).CacheControl("public, max-age=31536000, immutable");
    }

    public const string RateLimit = "query";

    /// <summary>Per client, by the address Cloudflare saw, since every request arrives through the tunnel.</summary>
    public static void AddQueryRateLimit(this IServiceCollection services, IConfiguration configuration)
    {
        var perMinute = configuration.GetValue("Query:RequestsPerMinute", new QueryOptions().RequestsPerMinute);
        services.AddRateLimiter(limiter =>
        {
            limiter.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            limiter.AddPolicy(RateLimit, context => RateLimitPartition.GetFixedWindowLimiter(
                context.Request.Headers["CF-Connecting-IP"].FirstOrDefault() ?? context.Connection.RemoteIpAddress?.ToString() ?? string.Empty,
                _ => new FixedWindowRateLimiterOptions { PermitLimit = perMinute, Window = TimeSpan.FromMinutes(1) }));
        });
    }

    private static RouteHandlerBuilder CacheControl(this RouteHandlerBuilder builder, string value) =>
        builder.AddEndpointFilter(async (context, next) =>
        {
            context.HttpContext.Response.Headers.CacheControl = value;
            return await next(context);
        });

    private static async Task<IResult> RunAsync(string sql, HttpRequest request, CatalogStore store, QueryOptions options, SemaphoreSlim slots, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(sql))
        {
            return Results.BadRequest(new { error = "empty query" });
        }

        await slots.WaitAsync(ct);
        try
        {
            using var connection = store.OpenReadOnly();
            if (SelectOnlyError(connection, sql) is { } rejected)
            {
                return Results.BadRequest(new { error = rejected });
            }

            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(options.Timeout);
            using var command = connection.CreateCommand();
            command.CommandText = sql;
            command.UseStreamingMode = true;
            using var cancel = timeout.Token.Register(command.Cancel);
            try
            {
                using var reader = await command.ExecuteReaderAsync(timeout.Token);
                var columns = Enumerable.Range(0, reader.FieldCount).Select(reader.GetName).ToArray();
                var types = Enumerable.Range(0, reader.FieldCount).Select(i => reader.GetDataTypeName(i).ToUpperInvariant()).ToArray();
                var rows = new List<object?[]>();
                var truncated = false;
                var bytes = 0L;
                while (await reader.ReadAsync(timeout.Token))
                {
                    if (rows.Count == options.MaxRows || bytes > options.MaxBytes)
                    {
                        truncated = true;
                        break;
                    }
                    var row = new object?[columns.Length];
                    for (var i = 0; i < row.Length; i++)
                    {
                        row[i] = reader.IsDBNull(i) ? null : Normalize(reader.GetValue(i));
                        bytes += row[i] is string text ? text.Length * 2L : 16;
                    }
                    rows.Add(row);
                }
                request.HttpContext.Response.Headers["X-Truncated"] = truncated ? "true" : "false";
                return request.Headers["format"] == "JSONCompact"
                    ? Results.Json(new { meta = columns.Zip(types, (name, type) => new { name, type }), data = rows, rows = rows.Count })
                    : Results.Text(string.Join('\n', rows.Select(row => JsonSerializer.Serialize(columns.Zip(row).ToDictionary()))), "application/x-ndjson", Encoding.UTF8);
            }
            catch (DbException e)
            {
                return Results.BadRequest(new { error = timeout.IsCancellationRequested && !ct.IsCancellationRequested ? $"query exceeded {options.Timeout}" : e.Message });
            }
        }
        finally
        {
            slots.Release();
        }
    }

    /// <summary>
    /// DuckDB only serializes SELECT statements, so its parser decides: COPY, ATTACH, SET, CREATE and
    /// anything else that could write or reconfigure is rejected before it runs.
    /// </summary>
    private static string? SelectOnlyError(DuckDBConnection connection, string sql)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT json_serialize_sql($sql::VARCHAR)";
        command.Parameters.Add(new DuckDBParameter("sql", sql));
        using var document = JsonDocument.Parse((string)command.ExecuteScalar()!);
        return document.RootElement.TryGetProperty("error", out var error) && error.GetBoolean()
            ? document.RootElement.GetProperty("error_message").GetString()
            : null;
    }

    private static object? Normalize(object value) => value switch
    {
        DateOnly date => date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        System.Numerics.BigInteger big => big.ToString(CultureInfo.InvariantCulture),
        _ => value,
    };
}
