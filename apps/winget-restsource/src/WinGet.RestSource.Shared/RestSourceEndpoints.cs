using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace WinGet.RestSource;

public sealed class RestSourceHostOptions
{
    /// <summary>External base URL of this host, used in installer URLs; defaults to the URL the request arrived on.</summary>
    public string? PublicBaseUrl { get; set; }
}

/// <summary>Maps the WinGet REST protocol endpoints for a source under a path prefix.</summary>
public static class RestSourceEndpoints
{
    public static RouteGroupBuilder MapRestSource<TSource>(this IEndpointRouteBuilder app, string prefix)
        where TSource : class, IWinGetSource
    {
        var group = app.MapGroup(prefix);

        group.MapGet("/information", (TSource source) => new Response<InformationResponse>(source.Information));

        group.MapPost("/manifestSearch", async (
            ManifestSearchRequest request, TSource source, CancellationToken cancellationToken) =>
            new ManifestSearchResponse(
                await source.SearchAsync(request, cancellationToken),
                PackageMatchFields.UnsupportedIn(request, source.Information.UnsupportedPackageMatchFields)));

        // An unknown package is 200 with no Data: the client reads 404 as the endpoint itself being absent
        // and reports "The rest API endpoint is not found" rather than that nothing matched.
        group.MapGet("/packageManifests/{packageIdentifier}", async (
            string packageIdentifier,
            string? version,
            string? market,
            HttpContext context,
            TSource source,
            CancellationToken cancellationToken) =>
            new Response<Manifest?>(await source.GetManifestAsync(
                new ManifestRequest(packageIdentifier, version, market, BaseUrl(context, prefix)), cancellationToken)));

        return group;
    }

    /// <summary>
    /// Serves the source's installer shim at /shim.exe; WinGet verifies the download against the
    /// InstallerSha256 in the manifests, which the <see cref="ShimFile"/> computes from these exact bytes.
    /// </summary>
    public static RouteGroupBuilder MapShim(this RouteGroupBuilder group, string serviceKey)
    {
        group.MapGet("/shim.exe", (HttpContext context) =>
            context.RequestServices.GetRequiredKeyedService<ShimFile>(serviceKey) is { Bytes: { } bytes } shim
                ? Results.File(bytes, "application/vnd.microsoft.portable-executable", shim.FileName)
                : Results.NotFound());

        return group;
    }

    private static string BaseUrl(HttpContext context, string prefix)
    {
        var options = context.RequestServices.GetRequiredService<IOptions<RestSourceHostOptions>>().Value;
        var host = options.PublicBaseUrl?.TrimEnd('/')
            ?? $"{context.Request.Scheme}://{context.Request.Host}{context.Request.PathBase}";

        return host + prefix;
    }
}
