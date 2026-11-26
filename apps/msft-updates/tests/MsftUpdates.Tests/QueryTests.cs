using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Xunit;

namespace MsftUpdates.Tests;

public sealed class SyncedCatalog : IAsyncLifetime
{
    public CatalogFactory Factory { get; } = new();

    public Task InitializeAsync() => Factory.SyncAsync();

    public Task DisposeAsync()
    {
        Factory.Dispose();
        return Task.CompletedTask;
    }
}

public sealed class QueryTests(SyncedCatalog catalog) : IClassFixture<SyncedCatalog>
{
    private readonly HttpClient _client = catalog.Factory.CreateClient();

    [Fact]
    public async Task Query_FindsDriverUrlByHardwareId()
    {
        var (result, truncated) = await PostAsync("""
            SELECT f.url, d.driver_version
            FROM driver_metadata d JOIN files f USING (update_id, revision)
            WHERE d.hardware_id = 'pci\ven_8086&dev_1916&subsys_39f217aa'
            """);

        Assert.Equal(["url", "driver_version"], result.GetProperty("meta").EnumerateArray().Select(c => c.GetProperty("name").GetString()));
        Assert.Equal(["VARCHAR", "VARCHAR"], result.GetProperty("meta").EnumerateArray().Select(c => c.GetProperty("type").GetString()));
        var row = Assert.Single(result.GetProperty("data").EnumerateArray());
        Assert.Equal(FakeUpdateServer.DriverUrl, row[0].GetString());
        Assert.Equal("21.20.16.4542", row[1].GetString());
        Assert.Equal(1, result.GetProperty("rows").GetInt32());
        Assert.False(truncated);
    }

    [Fact]
    public async Task Query_DefaultsToJsonEachRow()
    {
        var response = await _client.PostAsync("/", new StringContent("SELECT kb_article, title FROM updates WHERE kb_article = '5023052'"));

        Assert.Equal("""{"kb_article":"5023052","title":"Azure File Sync Agent v16.2 Release \u2013 February 2024 (KB5023052)"}""", await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Query_TruncatesAtMaxRows()
    {
        var (result, truncated) = await PostAsync("SELECT * FROM range(200000)");

        Assert.Equal(100_000, result.GetProperty("rows").GetInt32());
        Assert.True(truncated);
    }

    [Fact]
    public async Task Query_LargeValues_TruncateAtMaxBytes()
    {
        var (result, truncated) = await PostAsync("SELECT repeat('x', 1 << 20) FROM range(100)");

        Assert.InRange(result.GetProperty("rows").GetInt32(), 1, 40);
        Assert.True(truncated);
    }

    [Theory]
    [InlineData("SHOW DATABASES")]
    [InlineData("SELECT table_schema, table_name FROM information_schema.tables WHERE table_catalog = 'memory'")]
    [InlineData("DESCRIBE memory.main.updates")]
    public async Task Query_AllowsDuckUiCatalogQueries(string sql) => await PostAsync(sql);

    [Theory]
    [InlineData("COPY updates TO '/tmp/out.parquet'")]
    [InlineData("CREATE TABLE t AS SELECT 1")]
    [InlineData("ATTACH '/tmp/x.duckdb'")]
    [InlineData("SET enable_external_access = true")]
    [InlineData("SELECT 1; DROP VIEW updates")]
    [InlineData("SELECT * FROM read_csv('/etc/passwd')")]
    [InlineData("SELECT * FROM read_text('/etc/hostname')")]
    [InlineData("SELECT * FROM read_parquet('https://example.com/x.parquet')")]
    public async Task Query_RejectsWritesAndReadsOutsideTheCatalog(string sql)
    {
        var response = await _client.PostAsync("/", new StringContent(sql));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Files_ServesTheParquetParts()
    {
        var files = await _client.GetFromJsonAsync<string[]>("/files");

        var part = files!.First(f => f.StartsWith("driver_metadata/", StringComparison.Ordinal));
        var bytes = await _client.GetByteArrayAsync($"/files/{part}");
        Assert.Equal("PAR1"u8.ToArray(), bytes[..4]);
        Assert.Equal(HttpStatusCode.NotFound, (await _client.GetAsync("/files/../../etc/passwd")).StatusCode);
        Assert.True((await _client.GetAsync($"/files/{part}")).Headers.CacheControl!.Public);
    }

    [Fact]
    public async Task Query_LimitsRequestsPerClient()
    {
        var statuses = new List<HttpStatusCode>();
        for (var i = 0; i < 61; i++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "/") { Content = new StringContent("SELECT 1") };
            request.Headers.Add("CF-Connecting-IP", "192.0.2.1");
            statuses.Add((await _client.SendAsync(request)).StatusCode);
        }

        Assert.Equal(HttpStatusCode.TooManyRequests, statuses[^1]);
        Assert.Equal(HttpStatusCode.OK, statuses[0]);
    }

    private async Task<(JsonElement Result, bool Truncated)> PostAsync(string sql)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/") { Content = new StringContent(sql) };
        request.Headers.Add("format", "JSONCompact");
        var response = await _client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<JsonElement>(), response.Headers.GetValues("X-Truncated").Single() == "true");
    }
}
