using System.Security.Cryptography.X509Certificates;
using Microsoft.Extensions.Http.Resilience;
using WuMetadata.Catalog;
using WuMetadata.Query;
using WuMetadata.Sync;

var builder = WebApplication.CreateBuilder(args);

builder.Services.Configure<SyncOptions>(builder.Configuration.GetSection("Sync"));
builder.Services.Configure<CatalogOptions>(builder.Configuration.GetSection("Catalog"));
builder.Services.Configure<QueryOptions>(builder.Configuration.GetSection("Query"));

builder.Services.AddSingleton<CatalogStore>();
builder.Services.AddSingleton<SyncStatus>();
builder.Services.AddHttpClient<ServerSyncClient>(client => client.Timeout = Timeout.InfiniteTimeSpan)
    .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
    {
        SslOptions =
        {
            CertificateChainPolicy = new X509ChainPolicy
            {
                TrustMode = X509ChainTrustMode.CustomRootTrust,
                CustomTrustStore = { ServerSyncClient.Root },
            },
        },
    })
    .AddStandardResilienceHandler(options =>
    {
        // the full revision list is a ~60 MB response
        options.AttemptTimeout.Timeout = TimeSpan.FromMinutes(5);
        options.TotalRequestTimeout.Timeout = TimeSpan.FromMinutes(20);
        options.CircuitBreaker.SamplingDuration = TimeSpan.FromMinutes(10);
        options.Retry.MaxRetryAttempts = 6;
    });
if (builder.Configuration.GetValue("Sync:Enabled", true))
{
    builder.Services.AddHostedService<SyncService>();
}

var app = builder.Build();

app.MapQuery();

app.Run();

public partial class Program;
