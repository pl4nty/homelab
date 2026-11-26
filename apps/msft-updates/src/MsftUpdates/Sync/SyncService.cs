using System.Diagnostics;
using System.Threading.Channels;
using Microsoft.Extensions.Options;
using MsftUpdates.Catalog;

namespace MsftUpdates.Sync;

public sealed class SyncStatus
{
    public DateTimeOffset? Started { get; set; }
    public DateTimeOffset? Completed { get; set; }
    public string? Error { get; set; }
    public int Pending { get; set; }
    public int Fetched { get; set; }
    public int Stored { get; set; }
    public int Removed { get; set; }
}

/// <summary>
/// Mirrors Microsoft Update's metadata into the catalog: lists every current revision, fetches the ones
/// the catalog lacks, and marks the ones the server dropped as removed.
/// </summary>
public sealed class SyncService(
    ServerSyncClient client,
    CatalogStore store,
    SyncStatus status,
    IOptions<SyncOptions> options,
    ILogger<SyncService> logger) : BackgroundService
{
    private readonly SyncOptions _options = options.Value;

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await SyncAsync(ct);
            }
            catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                status.Error = e.Message;
                logger.LogError(e, "Sync failed");
            }
            await Task.Delay(_options.Interval, ct);
        }
    }

    public async Task SyncAsync(CancellationToken ct)
    {
        var clock = Stopwatch.StartNew();
        status.Started = DateTimeOffset.UtcNow;
        status.Error = null;
        status.Fetched = 0;
        var perRequest = await client.GetMaxUpdatesPerRequestAsync(ct);
        var stored = store.ReadRevisions();

        var categories = await client.GetCategoryRevisionsAsync(ct);
        var written = await FetchAsync([.. categories.Where(id => !stored.Contains(id))], perRequest, ct);

        var (products, classifications) = ReadCategoryIds();
        var updates = await client.GetUpdateRevisionsAsync(products, classifications, ct);
        var missing = updates.Where(id => !stored.Contains(id)).ToList();
        if (!_options.Full)
        {
            Random.Shared.Shuffle(System.Runtime.InteropServices.CollectionsMarshal.AsSpan(missing));
            missing = missing[..Math.Min(missing.Count, _options.SampleSize)];
        }
        logger.LogInformation("{Categories} categories, {Updates} updates listed, {Missing} to fetch", categories.Count, updates.Count, missing.Count);

        written += await FetchAsync(missing, perRequest, ct);

        var current = new HashSet<RevisionId>(categories);
        current.UnionWith(updates);
        var removed = stored.Where(id => !current.Contains(id)).ToList();
        var fraction = store.WriteRemoved(removed, stored.Count + written);
        var compact = fraction > _options.CompactionThreshold || store.Fragmented;
        if (compact)
        {
            logger.LogInformation("Compacting: {Removed} removed revisions ({Fraction:P1})", removed.Count, fraction);
            store.Compact();
        }

        status.Stored = stored.Count + written - (compact ? removed.Count : 0);
        status.Removed = removed.Count;
        status.Completed = DateTimeOffset.UtcNow;
        logger.LogInformation("Sync done in {Elapsed}: {Written} new, {Removed} removed", clock.Elapsed, written, removed.Count);
    }

    private (List<Guid> Products, List<Guid> Classifications) ReadCategoryIds()
    {
        using var connection = store.OpenDuckDb();
        store.CreateViews(connection);
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT update_id, category_type FROM updates WHERE update_type = 'Category'";
        using var reader = command.ExecuteReader();
        List<Guid> products = [], classifications = [];
        while (reader.Read())
        {
            (reader.GetString(1) == "UpdateClassification" ? classifications : products).Add(reader.GetGuid(0));
        }
        return (products, classifications);
    }

    private async Task<int> FetchAsync(List<RevisionId> ids, int perRequest, CancellationToken ct)
    {
        status.Pending = ids.Count;
        var parsed = Channel.CreateBounded<(ParsedUpdate Update, string Xml, int Units)>(64);
        var budget = new ByteBudget(_options.BufferBytes);
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct);

        var produce = Parallel.ForEachAsync(ids.Chunk(perRequest), new ParallelOptions { MaxDegreeOfParallelism = _options.Parallelism, CancellationToken = stop.Token },
            async (batch, token) =>
            {
                var data = await client.GetUpdateDataAsync(batch, token);
                foreach (var raw in data.Updates)
                {
                    // extraction holds the UTF-16 bytes and the string at once
                    var size = raw.Xml is { } text ? text.Length * 2L : 2 * Cabinet.UncompressedSize(raw.Cabinet ?? throw new InvalidDataException($"{raw.Id} has no XML"));
                    var units = await budget.AcquireAsync(size, token);
                    var xml = raw.Xml ?? await Cabinet.ExtractTextAsync(raw.Cabinet!, token);
                    await parsed.Writer.WriteAsync((UpdateParser.Parse(xml, data.FileUrls), xml, units), token);
                }
            }).ContinueWith(t => parsed.Writer.Complete(t.Exception?.GetBaseException()), TaskScheduler.Default);

        using var writer = store.CreateWriter();
        try
        {
            await foreach (var (update, xml, units) in parsed.Reader.ReadAllAsync(ct))
            {
                writer.Add(update, xml);
                budget.Release(units);
                status.Fetched++;
            }
        }
        finally
        {
            stop.Cancel();
            await produce;
        }
        writer.Flush();
        return writer.Written;
    }
}
