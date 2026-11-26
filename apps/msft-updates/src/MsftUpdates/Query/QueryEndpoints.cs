using System.Data.Common;
using System.Globalization;
using System.Text;
using System.Text.Json;
using DuckDB.NET.Data;
using Microsoft.Extensions.Options;
using WuMetadata.Catalog;
using WuMetadata.Sync;

namespace WuMetadata.Query;

public sealed class QueryOptions
{
    public int MaxRows { get; set; } = 100_000;

    public TimeSpan Timeout { get; set; } = TimeSpan.FromMinutes(2);

    public int MaxConcurrency { get; set; } = 2;
}

public static class QueryEndpoints
{
    public static void MapQuery(this WebApplication app)
    {
        var options = app.Services.GetRequiredService<IOptions<QueryOptions>>().Value;
        var slots = new SemaphoreSlim(options.MaxConcurrency);

        app.MapPost("/query", async (HttpRequest request, CatalogStore store, CancellationToken ct) =>
        {
            using var body = new StreamReader(request.Body, Encoding.UTF8);
            return await RunAsync(await body.ReadToEndAsync(ct), request, store, options, slots, ct);
        });
        app.MapGet("/query", (string sql, HttpRequest request, CatalogStore store, CancellationToken ct) =>
            RunAsync(sql, request, store, options, slots, ct));

        app.MapGet("/status", (SyncStatus status) => Results.Json(status, new JsonSerializerOptions { IncludeFields = true }));

        // the parts as-is, so DuckDB and other Parquet readers can query the catalog remotely
        app.MapGet("/files", (CatalogStore store) => Results.Json(
            Directory.Exists(store.DataPath)
                ? Directory.EnumerateFiles(store.DataPath, "*.parquet", SearchOption.AllDirectories)
                    .Select(f => Path.GetRelativePath(store.DataPath, f).Replace('\\', '/')).Order().ToArray()
                : Array.Empty<string>()));
        app.MapGet("/files/{**path}", (string path, CatalogStore store) =>
        {
            var full = Path.GetFullPath(Path.Combine(store.DataPath, path));
            return full.StartsWith(Path.GetFullPath(store.DataPath) + Path.DirectorySeparatorChar, StringComparison.Ordinal)
                && full.EndsWith(".parquet", StringComparison.Ordinal) && File.Exists(full)
                ? Results.File(full, "application/vnd.apache.parquet", enableRangeProcessing: true)
                : Results.NotFound();
        });
    }

    private static async Task<IResult> RunAsync(string sql, HttpRequest request, CatalogStore store, QueryOptions options, SemaphoreSlim slots, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(sql))
        {
            return Results.BadRequest(new { error = "empty query" });
        }
        var csv = request.Query["format"] == "csv" || request.Headers.Accept.ToString().Contains("text/csv", StringComparison.Ordinal);
        var maxRows = int.TryParse(request.Query["limit"], CultureInfo.InvariantCulture, out var limit) ? Math.Min(limit, options.MaxRows) : options.MaxRows;

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
                var rows = new List<object?[]>();
                var truncated = false;
                while (await reader.ReadAsync(timeout.Token))
                {
                    if (rows.Count == maxRows)
                    {
                        truncated = true;
                        break;
                    }
                    var row = new object?[columns.Length];
                    for (var i = 0; i < row.Length; i++)
                    {
                        row[i] = reader.IsDBNull(i) ? null : Normalize(reader.GetValue(i));
                    }
                    rows.Add(row);
                }
                return csv ? Csv(columns, rows, truncated) : Results.Json(new { columns, rows, truncated });
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

    private static IResult Csv(string[] columns, List<object?[]> rows, bool truncated)
    {
        static string Field(object? value)
        {
            var text = value switch
            {
                null => string.Empty,
                DateTime dt => dt.ToString("O", CultureInfo.InvariantCulture),
                IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
                _ => value.ToString() ?? string.Empty,
            };
            return text.IndexOfAny([',', '"', '\n', '\r']) >= 0 ? $"\"{text.Replace("\"", "\"\"", StringComparison.Ordinal)}\"" : text;
        }

        var builder = new StringBuilder();
        builder.AppendJoin(',', columns.Select(Field)).Append('\n');
        foreach (var row in rows)
        {
            builder.AppendJoin(',', row.Select(Field)).Append('\n');
        }
        return new CsvResult(builder.ToString(), truncated);
    }

    private sealed class CsvResult(string body, bool truncated) : IResult
    {
        public Task ExecuteAsync(HttpContext context)
        {
            context.Response.ContentType = "text/csv; charset=utf-8";
            context.Response.Headers["X-Truncated"] = truncated ? "true" : "false";
            return context.Response.WriteAsync(body);
        }
    }
}
