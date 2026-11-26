using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using WuMetadata.Catalog;
using WuMetadata.Sync;

namespace WuMetadata.Tests;

/// <summary>Hosts the service over an empty catalog in a temporary directory, syncing from <see cref="FakeUpdateServer"/>.</summary>
public sealed class CatalogFactory : WebApplicationFactory<Program>
{
    private readonly string _dataPath = Directory.CreateTempSubdirectory("wu-metadata-tests").FullName;

    public FakeUpdateServer UpdateServer { get; } = new();

    public string DataPath => _dataPath;

    public double CompactionThreshold { get; set; } = 0.05;

    public int MaxParts { get; set; } = 64;

    public Task SyncAsync() =>
        ActivatorUtilities.CreateInstance<SyncService>(Services).SyncAsync(CancellationToken.None);

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseSetting("Sync:Enabled", "false");
        builder.UseSetting("Catalog:DataPath", _dataPath);
        builder.ConfigureTestServices(services =>
        {
            services.Configure<SyncOptions>(options => options.CompactionThreshold = CompactionThreshold);
            services.Configure<CatalogOptions>(options => options.MaxParts = MaxParts);
            services.AddHttpClient<ServerSyncClient>().ConfigurePrimaryHttpMessageHandler(() => UpdateServer);
        });
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (Directory.Exists(_dataPath))
        {
            Directory.Delete(_dataPath, recursive: true);
        }
    }
}
