using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using WinGet.RestSource.Updates;
using WinGet.RestSource.Xbox;

namespace WinGet.RestSource.Tests;

/// <summary>
/// Hosts all three sources with the Store and Update Catalog replaced by canned responses, and with
/// stand-in shim executables whose hashes the tests can predict.
/// </summary>
public sealed class RestSourceFactory : WebApplicationFactory<Program>
{
    public static readonly byte[] ShimBytes = "MZ - not a real shim"u8.ToArray();

    public static readonly string ShimSha256 = Convert.ToHexString(SHA256.HashData(ShimBytes));

    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly string _shimDirectory = Directory.CreateTempSubdirectory("winget-restsource-tests").FullName;

    public RestSourceFactory()
    {
        File.WriteAllBytes(Path.Combine(_shimDirectory, "winget-feature-shim.exe"), ShimBytes);
        File.WriteAllBytes(Path.Combine(_shimDirectory, "winget-update-shim.exe"), ShimBytes);
    }

    public FakeStoreHandler Store { get; } = new();

    public FakeUpdateCatalogHandler UpdateCatalogPages { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseSetting("FeaturesSource:ShimPath", Path.Combine(_shimDirectory, "winget-feature-shim.exe"));
        builder.UseSetting("UpdatesSource:ShimPath", Path.Combine(_shimDirectory, "winget-update-shim.exe"));
        builder.ConfigureTestServices(services =>
        {
            services.AddHttpClient<StoreCatalog>().ConfigurePrimaryHttpMessageHandler(() => Store);
            services.AddHttpClient<UpdateCatalog>().ConfigurePrimaryHttpMessageHandler(() => UpdateCatalogPages);
        });
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);

        // The base class re-enters Dispose(bool) through DisposeAsync, so the delete must be idempotent.
        if (Directory.Exists(_shimDirectory))
        {
            Directory.Delete(_shimDirectory, recursive: true);
        }
    }
}

public static class HttpClientExtensions
{
    /// <summary>Posts a search to one source's prefix, e.g. <c>/xbox</c>.</summary>
    public static async Task<ManifestSearchResponse> SearchAsync(
        this HttpClient client, string prefix, ManifestSearchRequest request)
    {
        var response = await client.PostAsJsonAsync($"{prefix}/manifestSearch", request);
        response.EnsureSuccessStatusCode();

        return (await response.Content.ReadFromJsonAsync<ManifestSearchResponse>(RestSourceFactory.Json))!;
    }

    /// <summary>
    /// An unknown package is 200 with no Data, not 404: WinGet reads 404 as the endpoint itself being
    /// absent and fails with "The rest API endpoint is not found" instead of reporting no match.
    /// </summary>
    public static async Task<Manifest?> GetManifestAsync(this HttpClient client, string prefix, string packageIdentifier)
    {
        var response = await client.GetAsync($"{prefix}/packageManifests/{packageIdentifier}");
        response.EnsureSuccessStatusCode();

        return (await response.Content.ReadFromJsonAsync<Response<Manifest?>>(RestSourceFactory.Json))!.Data;
    }
}
