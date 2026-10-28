using System.Net.Http.Json;
using Xunit;

namespace WinGet.RestSource.Tests;

public sealed class UpdatesSourceTests(RestSourceFactory factory) : IClassFixture<RestSourceFactory>
{
    private const string Prefix = "/updates";

    private readonly HttpClient _client = factory.CreateClient();

    [Fact]
    public async Task Information_DescribesTheSource()
    {
        var response = await _client.GetFromJsonAsync<Response<InformationResponse>>(
            $"{Prefix}/information", RestSourceFactory.Json);

        Assert.Equal("WindowsUpdateCatalog", response!.Data.SourceIdentifier);
        Assert.Contains("1.6.0", response.Data.ServerSupportedVersions);
        Assert.Contains("Moniker", response.Data.UnsupportedPackageMatchFields);
    }

    [Fact]
    public async Task Search_ParsesCatalogRows()
    {
        var results = await _client.SearchAsync(Prefix, new ManifestSearchRequest(
            Query: new SearchRequestMatch("cumulative", "Substring")));

        Assert.Equal(3, results.Data.Count);

        var update = results.Data[0];
        Assert.Equal(UpdateCatalogFixture.MsuUpdateId, update.PackageIdentifier);
        Assert.Equal(UpdateCatalogFixture.MsuTitle, update.PackageName);
        Assert.Equal("Microsoft", update.Publisher);
        // Patches carry no catalog version (the KB stays in the title); drivers usually do.
        Assert.Equal("Unknown", update.Versions[0].PackageVersion);
        Assert.Equal("1.2.3.4", results.Data[1].Versions[0].PackageVersion);
    }

    [Fact]
    public async Task Search_WithoutKeyword_ReturnsNothingWithoutCallingTheCatalog()
    {
        using var factory = new RestSourceFactory();

        var results = await factory.CreateClient().SearchAsync(Prefix, new ManifestSearchRequest(FetchAllManifests: true));

        Assert.Empty(results.Data);
        Assert.Empty(factory.UpdateCatalogPages.Requests);
    }

    [Fact]
    public async Task Search_ByUpdateIdentifier_ReturnsItsSingleRow()
    {
        // `winget install --id` sends the update GUID, which the catalog resolves directly.
        var results = await _client.SearchAsync(Prefix, new ManifestSearchRequest(
            Inclusions: [new SearchRequestPackageMatchFilter(
                PackageMatchFields.PackageIdentifier,
                new SearchRequestMatch(UpdateCatalogFixture.MsuUpdateId.ToUpperInvariant(), "Exact"))]));

        Assert.Equal(UpdateCatalogFixture.MsuUpdateId, Assert.Single(results.Data).PackageIdentifier);
    }

    [Fact]
    public async Task Search_AppliesExactNameFilter()
    {
        var results = await _client.SearchAsync(Prefix, new ManifestSearchRequest(
            Query: new SearchRequestMatch("surface", "Substring"),
            Filters: [new SearchRequestPackageMatchFilter(
                PackageMatchFields.PackageName, new SearchRequestMatch(UpdateCatalogFixture.DriverTitle, "Exact"))]));

        Assert.Equal(UpdateCatalogFixture.DriverUpdateId, Assert.Single(results.Data).PackageIdentifier);
    }

    [Fact]
    public async Task Search_HonoursMaximumResults()
    {
        var results = await _client.SearchAsync(Prefix, new ManifestSearchRequest(
            MaximumResults: 1, Query: new SearchRequestMatch("cumulative", "Substring")));

        Assert.Single(results.Data);
    }

    [Fact]
    public async Task Search_ReportsOnlyTheUnsupportedFieldsTheRequestUsed()
    {
        var honoured = await _client.SearchAsync(Prefix, new ManifestSearchRequest(
            Query: new SearchRequestMatch("cumulative", "Substring")));

        Assert.Null(honoured.UnsupportedPackageMatchFields);

        var ignored = await _client.SearchAsync(Prefix, new ManifestSearchRequest(
            Query: new SearchRequestMatch("cumulative", "Substring"),
            Filters: [new SearchRequestPackageMatchFilter("Moniker", new SearchRequestMatch("kb5063878"))]));

        Assert.Equal(["Moniker"], ignored.UnsupportedPackageMatchFields!);
    }

    [Fact]
    public async Task PackageManifests_MsuUpdate_DelegatesToWusaThroughTheShim()
    {
        var manifest = await _client.GetManifestAsync(Prefix, UpdateCatalogFixture.MsuUpdateId);

        Assert.Equal(UpdateCatalogFixture.MsuUpdateId, manifest!.PackageIdentifier);

        var version = Assert.Single(manifest.Versions);
        Assert.Equal("Unknown", version.PackageVersion);
        Assert.Equal(UpdateCatalogFixture.MsuTitle, version.DefaultLocale.PackageName);
        Assert.Equal("This security update includes quality improvements.", version.DefaultLocale.ShortDescription);
        Assert.Contains("Classification: Security Updates", version.DefaultLocale.Description);
        Assert.Contains(UpdateCatalogFixture.MsuUpdateId, version.DefaultLocale.PackageUrl);

        var installer = Assert.Single(version.Installers);
        Assert.Equal("exe", installer.InstallerType);
        Assert.Equal("x64", installer.Architecture);
        Assert.Equal("http://localhost/updates/shim.exe", installer.InstallerUrl);
        Assert.Equal(RestSourceFactory.ShimSha256, installer.InstallerSha256);
        Assert.Equal("machine", installer.Scope);
        Assert.Equal("elevationRequired", installer.ElevationRequirement);
        Assert.Equal("2026-08-12", installer.ReleaseDate);
        Assert.Contains(
            $"/type:msu /url:{UpdateCatalogFixture.MsuFileUrl} /sha256:{UpdateCatalogFixture.MsuFileSha256}",
            installer.InstallerSwitches!.Custom);
        Assert.DoesNotContain("/driver", installer.InstallerSwitches.Custom);
        Assert.Contains(installer.ExpectedReturnCodes!, code =>
            code is { InstallerReturnCode: 3010, ReturnResponse: "rebootRequiredToFinish" });
    }

    [Fact]
    public async Task PackageManifests_DriverCab_DelegatesToPnputilThroughTheShim()
    {
        var manifest = await _client.GetManifestAsync(Prefix, UpdateCatalogFixture.DriverUpdateId);

        var version = Assert.Single(manifest!.Versions);
        Assert.Equal("1.2.3.4", version.PackageVersion);

        var installer = Assert.Single(version.Installers);
        // amd64 in the driver's file name, not x64.
        Assert.Equal("x64", installer.Architecture);
        Assert.Contains("/type:cab", installer.InstallerSwitches!.Custom);
        Assert.EndsWith("/driver", installer.InstallerSwitches.Custom);
    }

    [Fact]
    public async Task PackageManifests_ReturnsNoDataWhenNoFileIsInstallable()
    {
        // Self-extracting .exe payloads (e.g. Defender platform updates) cannot be installed silently
        // and verifiably by the shim, so the update is not installable even though it is searchable.
        Assert.Null(await _client.GetManifestAsync(Prefix, UpdateCatalogFixture.ExeUpdateId));
    }

    [Fact]
    public async Task PackageManifests_ReturnsNoDataForUnknownUpdate()
    {
        Assert.Null(await _client.GetManifestAsync(Prefix, "00000000-0000-0000-0000-000000000000"));
        Assert.Null(await _client.GetManifestAsync(Prefix, $"{UpdateCatalogFixture.MsuUpdateId}?Version=9.9.9"));
    }

    [Fact]
    public async Task PackageManifests_RejectsMalformedIdentifierWithoutCallingTheCatalog()
    {
        using var factory = new RestSourceFactory();

        Assert.Null(await factory.CreateClient().GetManifestAsync(Prefix, "KB5063878"));
        Assert.Empty(factory.UpdateCatalogPages.Requests);
    }

    [Fact]
    public async Task ShimEndpoint_ServesTheExactBytesTheManifestHashes()
    {
        var response = await _client.GetAsync($"{Prefix}/shim.exe");
        response.EnsureSuccessStatusCode();

        Assert.Equal("application/vnd.microsoft.portable-executable", response.Content.Headers.ContentType!.MediaType);
        Assert.Equal(RestSourceFactory.ShimBytes, await response.Content.ReadAsByteArrayAsync());
    }
}
