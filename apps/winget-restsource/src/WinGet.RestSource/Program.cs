using System.Security.Cryptography.X509Certificates;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;
using WinGet.RestSource;
using WinGet.RestSource.Features;
using WinGet.RestSource.Updates;
using WinGet.RestSource.Versions;
using WinGet.RestSource.Xbox;

var builder = WebApplication.CreateBuilder(args);

builder.Services.Configure<RestSourceHostOptions>(builder.Configuration.GetSection("RestSource"));
builder.Services.Configure<XboxSourceOptions>(builder.Configuration.GetSection("XboxSource"));
builder.Services.Configure<FeaturesSourceOptions>(builder.Configuration.GetSection("FeaturesSource"));
builder.Services.Configure<UpdatesSourceOptions>(builder.Configuration.GetSection("UpdatesSource"));
builder.Services.Configure<VersionsSourceOptions>(builder.Configuration.GetSection("VersionsSource"));

builder.Services.ConfigureHttpJsonOptions(options =>
{
    // The REST source contract is PascalCase; requests are still matched case-insensitively.
    options.SerializerOptions.PropertyNamingPolicy = null;
    options.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
});

builder.Services.AddMemoryCache();

builder.Services.AddScoped<XboxSource>();
builder.Services.AddHttpClient<StoreCatalog>(client =>
        client.DefaultRequestHeaders.UserAgent.ParseAdd("winget-restsource/1.0"))
    .AddStandardResilienceHandler();

builder.Services.AddSingleton<FeatureCatalog>();
builder.Services.AddSingleton<FeaturesSource>();
builder.Services.AddShim<FeaturesSourceOptions>(FeaturesSource.ShimKey, options => options.ShimPath);

builder.Services.AddScoped<UpdatesSource>();
builder.Services.AddShim<UpdatesSourceOptions>(UpdatesSource.ShimKey, options => options.ShimPath);
builder.Services.AddHttpClient<UpdateCatalog>(client =>
        client.DefaultRequestHeaders.UserAgent.ParseAdd("winget-restsource/1.0"))
    .AddStandardResilienceHandler();

builder.Services.AddScoped<VersionsSource>();
builder.Services.AddHttpClient<StoreDelivery>(client =>
        client.DefaultRequestHeaders.UserAgent.ParseAdd("winget-restsource/1.0"))
    .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
    {
        SslOptions =
        {
            CertificateChainPolicy = new X509ChainPolicy
            {
                TrustMode = X509ChainTrustMode.CustomRootTrust,
                CustomTrustStore = { StoreDelivery.Root },
            },
        },
    })
    .AddStandardResilienceHandler();

var app = builder.Build();

// One WinGet REST source per path prefix; add each with e.g.
// `winget source add --name xbox --arg https://host/xbox --type Microsoft.Rest`.
app.MapRestSource<XboxSource>("/xbox");
app.MapRestSource<FeaturesSource>("/features").MapShim(FeaturesSource.ShimKey);
app.MapRestSource<UpdatesSource>("/updates").MapShim(UpdatesSource.ShimKey);
app.MapRestSource<VersionsSource>("/msstore-versioned");

app.Run();

public partial class Program;

internal static class ShimRegistration
{
    public static IServiceCollection AddShim<TOptions>(
        this IServiceCollection services, string key, Func<TOptions, string> path) where TOptions : class =>
        services.AddKeyedSingleton(key, (provider, _) => ShimFile.Load(
            Path.Combine(
                provider.GetRequiredService<IHostEnvironment>().ContentRootPath,
                path(provider.GetRequiredService<IOptions<TOptions>>().Value)),
            provider.GetRequiredService<ILogger<ShimFile>>()));
}
