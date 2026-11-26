using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Http.Resilience;
using MsftUpdates.Catalog;
using MsftUpdates.Sync;

namespace MsftUpdates.Tests;

/// <summary>Hosts the service over an empty catalog in a temporary directory, syncing from <see cref="FakeUpdateServer"/>.</summary>
public sealed class CatalogFactory : WebApplicationFactory<Program>
{
    public string DataPath { get; } = Directory.CreateTempSubdirectory("msft-updates-tests").FullName;

    public FakeUpdateServer UpdateServer { get; } = new();

    public double CompactionThreshold { get; set; } = 0.05;

    public int MaxParts { get; set; } = 64;

    public int? SampleSize { get; set; }

    public Task SyncAsync() =>
        ActivatorUtilities.CreateInstance<SyncService>(Services).SyncAsync(CancellationToken.None);

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseSetting("Sync:Enabled", "false");
        builder.UseSetting("Catalog:DataPath", DataPath);
        builder.ConfigureTestServices(services =>
        {
            services.Configure<SyncOptions>(options =>
            {
                options.CompactionThreshold = CompactionThreshold;
                options.Full = SampleSize is null;
                options.SampleSize = SampleSize ?? options.SampleSize;
            });
            services.Configure<CatalogOptions>(options => options.MaxParts = MaxParts);
            services.AddHttpClient<ServerSyncClient>().ConfigurePrimaryHttpMessageHandler(() => UpdateServer);
            services.Configure<HttpStandardResilienceOptions>("ServerSyncClient-standard", options =>
            {
                options.AttemptTimeout.Timeout = TimeSpan.FromSeconds(1);
                options.Retry.Delay = TimeSpan.Zero;
            });
        });
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (Directory.Exists(DataPath))
        {
            Directory.Delete(DataPath, recursive: true);
        }
    }
}
