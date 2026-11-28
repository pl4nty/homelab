using System.Net.Http.Json;
using Xunit;

namespace WinGet.RestSource.Tests;

public sealed class VersionsSourceTests(RestSourceFactory factory) : IClassFixture<RestSourceFactory>
{
    private const string Prefix = "/msstore-versioned";

    private readonly HttpClient _client = factory.CreateClient();

    [Fact]
    public async Task Information_DescribesTheSource()
    {
        var response = await _client.GetFromJsonAsync<Response<InformationResponse>>(
            $"{Prefix}/information", RestSourceFactory.Json);

        Assert.Equal("StoreVersions", response!.Data.SourceIdentifier);
        Assert.Contains("Moniker", response.Data.UnsupportedPackageMatchFields);
    }

    [Fact]
    public async Task Search_ByStoreIdentifier_ListsEveryDeliveredVersion()
    {
        var results = await _client.SearchAsync(Prefix, new ManifestSearchRequest(
            Inclusions: [new SearchRequestPackageMatchFilter(
                PackageMatchFields.PackageIdentifier, new SearchRequestMatch(StoreFixture.TerminalId, "Exact"))]));

        var app = Assert.Single(results.Data);
        Assert.Equal(StoreFixture.TerminalId, app.PackageIdentifier);
        Assert.Equal("Windows Terminal", app.PackageName);
        Assert.Equal("Microsoft Corporation", app.Publisher);

        // Newest first; the VCLibs dependency in the same sync is not a version of the app.
        Assert.Equal([DeliveryFixture.Latest, DeliveryFixture.Previous], app.Versions.Select(version => version.PackageVersion));
        Assert.Equal(["Microsoft.WindowsTerminal_8wekyb3d8bbwe"], app.Versions[0].PackageFamilyNames!);
    }

    [Fact]
    public async Task Search_ByKeyword_KeepsApplicationsOnly()
    {
        var results = await _client.SearchAsync(Prefix, new ManifestSearchRequest(Query: new SearchRequestMatch("terminal", "Substring")));

        Assert.Equal([StoreFixture.TerminalId], results.Data.Select(result => result.PackageIdentifier));
    }

    [Fact]
    public async Task Search_SkipsProductsFe3DoesNotDeliver()
    {
        var results = await _client.SearchAsync(Prefix, new ManifestSearchRequest(Query: new SearchRequestMatch(StoreFixture.ApplicationId, "Exact")));

        Assert.Empty(results.Data);
    }

    [Fact]
    public async Task Manifest_HasASignedInstallerPerVersion()
    {
        var manifest = await _client.GetManifestAsync(Prefix, StoreFixture.TerminalId);

        Assert.NotNull(manifest);
        Assert.Equal([DeliveryFixture.Latest, DeliveryFixture.Previous], manifest.Versions.Select(version => version.PackageVersion));

        var installer = Assert.Single(manifest.Versions[1].Installers);
        Assert.Equal("msix", installer.InstallerType);
        Assert.Equal("neutral", installer.Architecture);
        Assert.Equal(DeliveryFixture.PreviousUrl, installer.InstallerUrl);
        Assert.Equal(DeliveryFixture.PreviousSha256, installer.InstallerSha256);
        Assert.Equal("Microsoft.WindowsTerminal_8wekyb3d8bbwe", installer.PackageFamilyName);
        Assert.Equal("2026-07-13", installer.ReleaseDate);
        Assert.Equal(DeliveryFixture.LatestSha256, manifest.Versions[0].Installers[0].InstallerSha256);
    }

    [Fact]
    public async Task Manifest_ForOneVersion()
    {
        var response = await _client.GetFromJsonAsync<Response<Manifest?>>(
            $"{Prefix}/packageManifests/{StoreFixture.TerminalId}?Version={DeliveryFixture.Previous}", RestSourceFactory.Json);

        Assert.Equal(DeliveryFixture.Previous, Assert.Single(response!.Data!.Versions).PackageVersion);
    }

    [Fact]
    public async Task Manifest_UnknownPackage_IsEmpty()
    {
        Assert.Null(await _client.GetManifestAsync(Prefix, StoreFixture.ApplicationId));
    }

    [Fact]
    public async Task Packages_AreCachedBetweenRequests()
    {
        using var factory = new RestSourceFactory();
        var client = factory.CreateClient();

        await client.GetManifestAsync(Prefix, StoreFixture.TerminalId);
        await client.GetManifestAsync(Prefix, StoreFixture.TerminalId);

        // One sync, but fresh file URLs each time: FE3 signs them for minutes.
        Assert.Equal(
            ["GetCookie", "SyncUpdates", "GetExtendedUpdateInfo2", "GetExtendedUpdateInfo2"],
            factory.Delivery.Actions);
    }
}
