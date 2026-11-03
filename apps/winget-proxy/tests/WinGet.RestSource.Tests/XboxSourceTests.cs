using System.Net.Http.Json;
using Xunit;

namespace WinGet.RestSource.Tests;

public sealed class XboxSourceTests(RestSourceFactory factory) : IClassFixture<RestSourceFactory>
{
    private const string Prefix = "/xbox";

    private readonly HttpClient _client = factory.CreateClient();

    [Fact]
    public async Task Information_DescribesTheSource()
    {
        var response = await _client.GetFromJsonAsync<Response<InformationResponse>>(
            $"{Prefix}/information", RestSourceFactory.Json);

        Assert.Equal("XboxStore", response!.Data.SourceIdentifier);
        Assert.Contains("1.6.0", response.Data.ServerSupportedVersions);
        Assert.Contains("Moniker", response.Data.UnsupportedPackageMatchFields);
        Assert.Equal("XboxStore", response.Data.SourceAgreements!.AgreementsIdentifier);
    }

    [Fact]
    public async Task Search_ReturnsInstallableGamesOnly()
    {
        using var factory = new RestSourceFactory();

        var results = await factory.CreateClient()
            .SearchAsync(Prefix, new ManifestSearchRequest(Query: new SearchRequestMatch("roblox", "Substring")));

        // The console-only title and the add-on are dropped before the catalog is asked for details.
        Assert.Equal(
            [StoreFixture.WindowsGameId, StoreFixture.PlayAnywhereGameId],
            results.Data.Select(result => result.PackageIdentifier));
        Assert.DoesNotContain(StoreFixture.ConsoleGameId, factory.Store.DetailedProductIds);
        Assert.DoesNotContain(StoreFixture.ConsumableId, factory.Store.DetailedProductIds);

        var game = results.Data[0];
        Assert.Equal("Roblox - Windows", game.PackageName);
        Assert.Equal("Roblox Corporation", game.Publisher);
        Assert.Equal("Unknown", game.Versions[0].PackageVersion);
        Assert.Equal(["ROBLOXCorporation.RobloxGDK_55nm5eh3cm0pr"], game.Versions[0].PackageFamilyNames!);
        Assert.Equal("1.0.13", results.Data[1].Versions[0].PackageVersion);
    }

    [Fact]
    public async Task Search_ByStoreIdentifier_SkipsTheSuggestCall()
    {
        using var factory = new RestSourceFactory();

        var results = await factory.CreateClient().SearchAsync(Prefix, new ManifestSearchRequest(
            Inclusions: [new SearchRequestPackageMatchFilter(
                PackageMatchFields.PackageIdentifier, new SearchRequestMatch(StoreFixture.WindowsGameId, "Exact"))]));

        Assert.Equal(StoreFixture.WindowsGameId, Assert.Single(results.Data).PackageIdentifier);
        Assert.Empty(factory.Store.SuggestRequests);
    }

    [Fact]
    public async Task Search_ByStoreIdentifier_IgnoresCase()
    {
        // `winget install --id` passes the identifier through as typed; the catalog reports it upper case.
        var results = await _client.SearchAsync(Prefix, new ManifestSearchRequest(
            Filters: [new SearchRequestPackageMatchFilter(
                PackageMatchFields.PackageIdentifier,
                new SearchRequestMatch(StoreFixture.WindowsGameId.ToLowerInvariant(), "Exact"))]));

        Assert.Equal(StoreFixture.WindowsGameId, Assert.Single(results.Data).PackageIdentifier);
    }

    [Fact]
    public async Task Search_ByConsoleOnlyStoreIdentifier_ReturnsNothing()
    {
        var results = await _client.SearchAsync(Prefix, new ManifestSearchRequest(
            Query: new SearchRequestMatch(StoreFixture.ConsoleGameId, "Exact")));

        Assert.Empty(results.Data);
    }

    [Fact]
    public async Task Search_AppliesExactNameFilter()
    {
        var request = new ManifestSearchRequest(
            Query: new SearchRequestMatch("roblox", "Substring"),
            Filters: [new SearchRequestPackageMatchFilter(
                PackageMatchFields.PackageName, new SearchRequestMatch("Halo Infinite", "Exact"))]);

        var results = await _client.SearchAsync(Prefix, request);

        Assert.Equal(StoreFixture.PlayAnywhereGameId, Assert.Single(results.Data).PackageIdentifier);
    }

    [Fact]
    public async Task Search_HonoursMaximumResults()
    {
        var results = await _client.SearchAsync(Prefix, new ManifestSearchRequest(
            MaximumResults: 1, Query: new SearchRequestMatch("roblox", "Substring")));

        Assert.Single(results.Data);
    }

    [Fact]
    public async Task Search_UsesRequestedMarket()
    {
        using var factory = new RestSourceFactory();

        await factory.CreateClient().SearchAsync(Prefix, new ManifestSearchRequest(
            Query: new SearchRequestMatch("roblox", "Substring"),
            Filters: [new SearchRequestPackageMatchFilter(PackageMatchFields.Market, new SearchRequestMatch("gb"))]));

        Assert.All(factory.Store.Requests, uri => Assert.Equal("GB", FakeStoreHandler.Market(uri)));
    }

    [Fact]
    public async Task Search_ReportsOnlyTheUnsupportedFieldsTheRequestUsed()
    {
        // In a search response the list means "these fields of your request were ignored". Returning the
        // whole set unconditionally makes WinGet log "Search request is not supported by the rest source"
        // for every search and drop the source from `winget upgrade` with "Failed when searching source".
        var honoured = await _client.SearchAsync(Prefix, new ManifestSearchRequest(
            Query: new SearchRequestMatch("roblox", "Substring")));

        Assert.Null(honoured.UnsupportedPackageMatchFields);

        var ignored = await _client.SearchAsync(Prefix, new ManifestSearchRequest(
            Query: new SearchRequestMatch("roblox", "Substring"),
            Filters: [new SearchRequestPackageMatchFilter("Moniker", new SearchRequestMatch("roblox"))]));

        Assert.Equal(["Moniker"], ignored.UnsupportedPackageMatchFields!);
    }

    [Fact]
    public async Task Search_WithoutKeyword_ReturnsNothing()
    {
        using var factory = new RestSourceFactory();

        var results = await factory.CreateClient().SearchAsync(Prefix, new ManifestSearchRequest(FetchAllManifests: true));

        Assert.Empty(results.Data);
        Assert.Empty(factory.Store.Requests);
    }

    [Fact]
    public async Task PackageManifests_ReturnsStoreInstaller()
    {
        var response = await _client.GetFromJsonAsync<Response<Manifest>>(
            $"{Prefix}/packageManifests/{StoreFixture.WindowsGameId}?Market=US", RestSourceFactory.Json);

        var manifest = response!.Data;
        Assert.Equal(StoreFixture.WindowsGameId, manifest.PackageIdentifier);

        var version = Assert.Single(manifest.Versions);
        Assert.Equal("Unknown", version.PackageVersion);
        Assert.Equal("Roblox - Windows", version.DefaultLocale.PackageName);
        Assert.Equal("https://www.xbox.com/games/store/-/9PMF91N3LZ3M", version.DefaultLocale.PackageUrl);
        Assert.Null(version.DefaultLocale.PublisherSupportUrl);

        var installer = Assert.Single(version.Installers);
        Assert.Equal("msstore", installer.InstallerType);
        Assert.Equal("neutral", installer.Architecture);
        Assert.Equal(StoreFixture.WindowsGameId, installer.MSStoreProductIdentifier);
        Assert.Equal("ROBLOXCorporation.RobloxGDK_55nm5eh3cm0pr", installer.PackageFamilyName);
        Assert.Equal("2016-01-27", installer.ReleaseDate);
        Assert.Equal(["Windows.Desktop"], installer.Platform!);
    }

    [Fact]
    public async Task PackageManifests_OmitsPlatformWhenTheCatalogHasNoPackages()
    {
        var manifest = await _client.GetManifestAsync(Prefix, StoreFixture.PlayAnywhereGameId);

        var installer = manifest!.Versions[0].Installers[0];
        Assert.Null(installer.Platform);
        Assert.Null(installer.PackageFamilyName);
        Assert.Equal(StoreFixture.PlayAnywhereGameId, installer.MSStoreProductIdentifier);
    }

    [Theory]
    [InlineData(StoreFixture.ConsoleGameId)]  // playable on a console only
    [InlineData(StoreFixture.ApplicationId)]  // an app, served by the msstore source instead
    [InlineData(StoreFixture.ConsumableId)]   // an add-on rather than a game
    [InlineData("ZZZZZZZZZZZZ")]              // unknown store id
    [InlineData("not-an-id")]                 // malformed store id
    public async Task PackageManifests_ReturnsNoDataForUninstallableProducts(string packageIdentifier)
    {
        Assert.Null(await _client.GetManifestAsync(Prefix, packageIdentifier));
    }

    [Fact]
    public async Task PackageManifests_RejectsMalformedIdentifierWithoutCallingTheStore()
    {
        using var factory = new RestSourceFactory();

        Assert.Null(await factory.CreateClient().GetManifestAsync(Prefix, "not-an-id"));
        Assert.Empty(factory.Store.Requests);
    }

    [Fact]
    public async Task PackageManifests_ReturnsNoDataForUnknownVersion()
    {
        Assert.Null(await _client.GetManifestAsync(Prefix, $"{StoreFixture.WindowsGameId}?Version=9.9.9"));
    }
}
