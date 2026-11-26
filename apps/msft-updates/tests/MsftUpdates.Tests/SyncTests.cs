using System.Net.Http.Json;
using System.Text.Json;
using Xunit;

namespace MsftUpdates.Tests;

public sealed class SyncTests : IDisposable
{
    private readonly CatalogFactory _factory = new();

    [Fact]
    public async Task Sync_StoresEveryListedRevision()
    {
        await _factory.SyncAsync();

        Assert.Equal(5, await ScalarAsync("SELECT count(*) FROM updates"));
        Assert.Equal(2, await ScalarAsync("SELECT count(*) FROM updates WHERE update_type = 'Category'"));
        // the server allows two updates per request
        Assert.Equal(3, _factory.UpdateServer.GetUpdateDataCalls);
        var filter = Assert.Single(_factory.UpdateServer.UpdateFilters);
        Assert.Contains($"<Categories><IdAndDelta><Id>{FakeUpdateServer.Product.UpdateId}</Id>", filter);
        Assert.Contains($"<Classifications><IdAndDelta><Id>{FakeUpdateServer.Classification.UpdateId}</Id>", filter);
    }

    [Fact(Timeout = 30_000)]
    public async Task Sync_RetriesAStalledResponse()
    {
        _factory.UpdateServer.StalledResponses = 1;

        await _factory.SyncAsync();

        Assert.Equal(5, await ScalarAsync("SELECT count(*) FROM updates"));
        Assert.Equal(4, _factory.UpdateServer.GetUpdateDataCalls);
    }

    [Fact]
    public async Task Sync_Sample_FetchesSampleSizeUpdatesPerSync()
    {
        _factory.SampleSize = 2;

        await _factory.SyncAsync();
        Assert.Equal(2, await ScalarAsync("SELECT count(*) FROM updates WHERE update_type <> 'Category'"));
        await _factory.SyncAsync();
        Assert.Equal(3, await ScalarAsync("SELECT count(*) FROM updates WHERE update_type <> 'Category'"));
    }

    [Fact]
    public async Task Sync_ExtractsCompressedUpdates()
    {
        await _factory.SyncAsync();

        var xml = await QueryAsync($"SELECT xml FROM update_xml WHERE update_id = '{FakeUpdateServer.Compressed.UpdateId}'");
        Assert.StartsWith("<upd:Update", Assert.Single(xml).GetString());
    }

    [Fact]
    public async Task Sync_Again_FetchesOnlyNewRevisions()
    {
        await _factory.SyncAsync();
        var calls = _factory.UpdateServer.GetUpdateDataCalls;

        await _factory.SyncAsync();

        Assert.Equal(calls, _factory.UpdateServer.GetUpdateDataCalls);
        Assert.Equal(5, await ScalarAsync("SELECT count(*) FROM updates"));
    }

    [Fact]
    public async Task Sync_HidesRevisionsTheServerDropped()
    {
        _factory.CompactionThreshold = 1;
        await _factory.SyncAsync();
        _factory.UpdateServer.Updates.Remove(FakeUpdateServer.Software);

        await _factory.SyncAsync();

        Assert.Equal(0, await ScalarAsync($"SELECT count(*) FROM updates WHERE update_id = '{FakeUpdateServer.Software.UpdateId}'"));
        Assert.Equal(0, await ScalarAsync($"SELECT count(*) FROM update_cves"));
        Assert.True(File.Exists(Path.Combine(_factory.DataPath, "removed.parquet")));
    }

    [Fact]
    public async Task Sync_CompactsOnceEnoughIsRemoved()
    {
        _factory.CompactionThreshold = 0;
        await _factory.SyncAsync();
        _factory.UpdateServer.Updates.Remove(FakeUpdateServer.Software);

        await _factory.SyncAsync();

        Assert.Equal(4, await ScalarAsync("SELECT count(*) FROM updates"));
        Assert.Equal(4, await ScalarAsync("SELECT count(*) FROM update_xml"));
        Assert.False(File.Exists(Path.Combine(_factory.DataPath, "removed.parquet")));
        Assert.Single(Directory.GetFiles(Path.Combine(_factory.DataPath, "updates"), "*.parquet"));
    }

    [Fact]
    public async Task Sync_MergesPartsPastMaxParts()
    {
        _factory.MaxParts = 1;

        await _factory.SyncAsync();

        Assert.Single(Directory.GetFiles(Path.Combine(_factory.DataPath, "updates"), "*.parquet"));
        Assert.Single(Directory.GetFiles(Path.Combine(_factory.DataPath, "update_xml"), "*.parquet"));
        Assert.Equal(5, await ScalarAsync("SELECT count(*) FROM updates"));
    }

    private async Task<long> ScalarAsync(string sql) => Assert.Single(await QueryAsync(sql)).GetInt64();

    private async Task<List<JsonElement>> QueryAsync(string sql)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/query") { Content = new StringContent(sql) };
        request.Headers.Add("format", "JSONCompact");
        var response = await _factory.CreateClient().SendAsync(request);
        response.EnsureSuccessStatusCode();
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        return [.. result.GetProperty("data").EnumerateArray().Select(row => row[0])];
    }

    public void Dispose() => _factory.Dispose();
}
