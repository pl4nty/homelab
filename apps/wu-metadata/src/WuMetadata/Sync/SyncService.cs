using System.Diagnostics;
using System.Threading.Channels;
using Microsoft.Extensions.Options;
using WuMetadata.Catalog;

namespace WuMetadata.Sync;

public sealed class SyncStatus
{
    public DateTimeOffset? Started { get; set; }
    public DateTimeOffset? Completed { get; set; }
    public string? Error { get; set; }
    public int Pending { get; set; }
    public int Fetched;
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
        var written = 0;
        using (var writer = store.CreateWriter())
        {
            await FetchAsync([.. categories.Where(id => !stored.Contains(id))], perRequest, writer, ct);
            writer.Flush();
            written += writer.Written;
        }

        var (products, classifications) = ReadCategoryIds();
        var updates = await client.GetUpdateRevisionsAsync(products, classifications, ct);
        var missing = updates.Where(id => !stored.Contains(id)).Take(_options.Full ? int.MaxValue : _options.SampleSize).ToList();
        logger.LogInformation("{Categories} categories, {Updates} updates listed, {Missing} to fetch", categories.Count, updates.Count, missing.Count);

        using (var writer = store.CreateWriter())
        {
            await FetchAsync(missing, perRequest, writer, ct);
            writer.Flush();
            written += writer.Written;
        }

        var current = new HashSet<RevisionId>(categories);
        current.UnionWith(updates);
        var removed = stored.Where(id => !current.Contains(id)).ToList();
        var fraction = store.WriteRemoved(removed, stored.Count + written);
        var compact = fraction > _options.CompactionThreshold ? [.. CatalogStore.Tables.Keys] : store.FragmentedTables().ToList();
        if (compact.Count > 0)
        {
            logger.LogInformation("Compacting {Tables}: {Removed} removed revisions ({Fraction:P1})", compact, removed.Count, fraction);
            store.Compact(compact);
        }

        status.Stored = stored.Count + written - (compact.Count == CatalogStore.Tables.Count ? removed.Count : 0);
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

    private async Task FetchAsync(List<RevisionId> ids, int perRequest, CatalogWriter writer, CancellationToken ct)
    {
        status.Pending = ids.Count;
        var fetched = Channel.CreateBounded<UpdateData>(4);
        var parsed = Channel.CreateBounded<(ParsedUpdate Update, string Xml)>(64);

        var download = Task.Run(async () =>
        {
            try
            {
                await Parallel.ForEachAsync(ids.Chunk(perRequest), new ParallelOptions { MaxDegreeOfParallelism = _options.Parallelism, CancellationToken = ct },
                    async (batch, token) => await fetched.Writer.WriteAsync(await client.GetUpdateDataAsync(batch, token), token));
                fetched.Writer.Complete();
            }
            catch (Exception e)
            {
                fetched.Writer.Complete(e);
            }
        }, ct);

        var parse = Task.Run(async () =>
        {
            try
            {
                await Parallel.ForEachAsync(fetched.Reader.ReadAllAsync(ct), new ParallelOptions { MaxDegreeOfParallelism = _options.Parallelism, CancellationToken = ct },
                    async (data, token) =>
                    {
                        foreach (var raw in data.Updates)
                        {
                            var xml = raw.Xml ?? await Cabinet.ExtractTextAsync(raw.Cabinet ?? throw new InvalidDataException($"{raw.Id} has no XML"), token);
                            await parsed.Writer.WriteAsync((UpdateParser.Parse(xml, data.FileUrls), xml), token);
                        }
                    });
                parsed.Writer.Complete();
            }
            catch (Exception e)
            {
                parsed.Writer.Complete(e);
            }
        }, ct);

        await foreach (var (update, xml) in parsed.Reader.ReadAllAsync(ct))
        {
            writer.Add(update, xml);
            Interlocked.Increment(ref status.Fetched);
        }
        await Task.WhenAll(download, parse);
    }
}
