using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Xunit;

namespace WinGet.RestSource.Tests;

public sealed class FeaturesSourceTests(RestSourceFactory factory) : IClassFixture<RestSourceFactory>
{
    private const string Prefix = "/features";
    private const string TelnetId = "Microsoft.Windows.Feature.TelnetClient";
    private const string SshServerId = "Microsoft.Windows.Capability.OpenSSH.Server";

    private readonly HttpClient _client = factory.CreateClient();

    [Fact]
    public async Task Information_DescribesTheSource()
    {
        var response = await _client.GetFromJsonAsync<Response<InformationResponse>>(
            $"{Prefix}/information", RestSourceFactory.Json);

        Assert.Equal("WindowsFeatures", response!.Data.SourceIdentifier);
        Assert.Contains("1.6.0", response.Data.ServerSupportedVersions);
        Assert.Contains("Command", response.Data.UnsupportedPackageMatchFields);
    }

    [Fact]
    public async Task Search_WithoutKeyword_ReturnsTheWholeCatalog()
    {
        // The catalog is finite, so FetchAllManifests is supported - `winget export` depends on it.
        var results = await _client.SearchAsync(Prefix, new ManifestSearchRequest(FetchAllManifests: true));

        Assert.True(results.Data.Count >= 25);
        Assert.Contains(results.Data, result => result.PackageIdentifier == TelnetId);
        Assert.Contains(results.Data, result => result.PackageIdentifier == "Microsoft.Windows.Capability.OpenSSH.Client");
        Assert.All(results.Data, result => Assert.Equal("Microsoft", result.Publisher));
    }

    [Fact]
    public async Task Search_ByKeyword_MatchesNamesAndDismNames()
    {
        var byDisplayName = await _client.SearchAsync(Prefix, new ManifestSearchRequest(
            Query: new SearchRequestMatch("telnet", "Substring")));
        Assert.Equal(TelnetId, Assert.Single(byDisplayName.Data).PackageIdentifier);

        // The DISM name is searchable too, e.g. `winget search NetFx3`.
        var byDismName = await _client.SearchAsync(Prefix, new ManifestSearchRequest(
            Query: new SearchRequestMatch("NetFx3", "Substring")));
        Assert.Equal("Microsoft.Windows.Feature.NetFx3", Assert.Single(byDismName.Data).PackageIdentifier);
    }

    [Fact]
    public async Task Search_ByMoniker_FindsWsl()
    {
        var results = await _client.SearchAsync(Prefix, new ManifestSearchRequest(
            Inclusions: [new SearchRequestPackageMatchFilter(
                PackageMatchFields.Moniker, new SearchRequestMatch("wsl", "Exact"))]));

        Assert.Equal(
            "Microsoft.Windows.Feature.Microsoft-Windows-Subsystem-Linux",
            Assert.Single(results.Data).PackageIdentifier);
    }

    [Fact]
    public async Task Search_ByIdentifier_IgnoresCase()
    {
        // `winget install --id` passes the identifier through as the user typed it.
        var results = await _client.SearchAsync(Prefix, new ManifestSearchRequest(
            Inclusions: [new SearchRequestPackageMatchFilter(
                PackageMatchFields.PackageIdentifier, new SearchRequestMatch(TelnetId.ToLowerInvariant(), "Exact"))]));

        Assert.Equal(TelnetId, Assert.Single(results.Data).PackageIdentifier);
    }

    [Fact]
    public async Task Search_AppliesExactNameFilter()
    {
        var results = await _client.SearchAsync(Prefix, new ManifestSearchRequest(
            Query: new SearchRequestMatch("ssh", "Substring"),
            Filters: [new SearchRequestPackageMatchFilter(
                PackageMatchFields.PackageName, new SearchRequestMatch("OpenSSH Server", "Exact"))]));

        Assert.Equal(SshServerId, Assert.Single(results.Data).PackageIdentifier);
    }

    [Fact]
    public async Task Search_HonoursMaximumResults()
    {
        var results = await _client.SearchAsync(Prefix, new ManifestSearchRequest(MaximumResults: 3, FetchAllManifests: true));

        Assert.Equal(3, results.Data.Count);
    }

    [Fact]
    public async Task Search_ReportsOnlyTheUnsupportedFieldsTheRequestUsed()
    {
        var honoured = await _client.SearchAsync(Prefix, new ManifestSearchRequest(
            Query: new SearchRequestMatch("telnet", "Substring")));

        Assert.Null(honoured.UnsupportedPackageMatchFields);

        var ignored = await _client.SearchAsync(Prefix, new ManifestSearchRequest(
            Query: new SearchRequestMatch("telnet", "Substring"),
            Filters: [new SearchRequestPackageMatchFilter("Command", new SearchRequestMatch("telnet"))]));

        Assert.Equal(["Command"], ignored.UnsupportedPackageMatchFields!);
    }

    [Fact]
    public async Task PackageManifests_ReturnsAShimInstallerThatEnablesTheFeature()
    {
        var manifest = await _client.GetManifestAsync(Prefix, TelnetId);

        Assert.Equal(TelnetId, manifest!.PackageIdentifier);

        var version = Assert.Single(manifest.Versions);
        Assert.Equal("Unknown", version.PackageVersion);
        Assert.Equal("Telnet Client", version.DefaultLocale.PackageName);
        Assert.Contains("TelnetClient", version.DefaultLocale.Description);

        var installer = Assert.Single(version.Installers);
        Assert.Equal("exe", installer.InstallerType);
        Assert.Equal("neutral", installer.Architecture);
        Assert.Equal("http://localhost/features/shim.exe", installer.InstallerUrl);
        Assert.Equal(RestSourceFactory.ShimSha256, installer.InstallerSha256);
        Assert.Equal("machine", installer.Scope);
        Assert.Equal("elevationRequired", installer.ElevationRequirement);
        Assert.Equal("WinGetFeature.Feature.TelnetClient", installer.ProductCode);
        Assert.Contains("/action:enable /kind:Feature /name:TelnetClient", installer.InstallerSwitches!.Custom);
        Assert.Contains(installer.ExpectedReturnCodes!, code =>
            code is { InstallerReturnCode: 3010, ReturnResponse: "rebootRequiredToFinish" });
    }

    [Fact]
    public async Task PackageManifests_CapabilityCarriesItsVersionedDismName()
    {
        var manifest = await _client.GetManifestAsync(Prefix, SshServerId);

        // The capability version comes from the DISM name suffix, and the shim needs the full name.
        var version = Assert.Single(manifest!.Versions);
        Assert.Equal("0.0.1.0", version.PackageVersion);
        Assert.Contains("/kind:Capability /name:OpenSSH.Server~~~~0.0.1.0", version.Installers[0].InstallerSwitches!.Custom);
        Assert.Equal("WinGetFeature.Capability.OpenSSH.Server", version.Installers[0].ProductCode);
    }

    [Theory]
    [InlineData("Microsoft.Windows.Feature.NoSuchFeature")]
    [InlineData($"{TelnetId}?Version=1.2.3")]
    public async Task PackageManifests_ReturnsNoDataWhenNothingMatches(string pathAndQuery)
    {
        Assert.Null(await _client.GetManifestAsync(Prefix, pathAndQuery));
    }

    [Fact]
    public async Task PackageManifests_HonoursConfiguredPublicBaseUrl()
    {
        using var factory = new RestSourceFactory();
        using var client = factory.WithWebHostBuilder(builder =>
                builder.UseSetting("RestSource:PublicBaseUrl", "https://winget.example.com/"))
            .CreateClient();

        var manifest = await client.GetManifestAsync(Prefix, TelnetId);

        Assert.Equal("https://winget.example.com/features/shim.exe", manifest!.Versions[0].Installers[0].InstallerUrl);
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
