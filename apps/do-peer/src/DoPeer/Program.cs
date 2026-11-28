using System.Net;
using System.Text.Json;
using DoPeer;

if (args is ["fetch", var peerArg, var phfArg, ..])
    return await FetchAsync(IPEndPoint.Parse(peerArg), phfArg, args.Length > 3 ? args[3] : null);
if (args is ["encrypt", var plainPath, var encryptedPath])
{
    using var cipher = new DoCipher(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));
    await File.WriteAllBytesAsync(encryptedPath, cipher.Encrypt(await File.ReadAllBytesAsync(plainPath)));
    Console.WriteLine(JsonSerializer.Serialize(cipher.DecryptionInfo));
    return 0;
}

var builder = WebApplication.CreateBuilder(args);
builder.Logging.AddFilter("Microsoft.AspNetCore", LogLevel.Warning);
// DO reads IntegrityCheckInfo and the pieces hash file with PascalCase names
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.PropertyNamingPolicy = null);
var content = builder.Configuration["Content"] ?? "/content";
var peerPort = builder.Configuration.GetValue("PeerPort", 7680);
builder.Services.AddSingleton(sp => new Library(content, sp.GetRequiredService<ILogger<Library>>()));
builder.Services.AddSingleton(sp => new PeerServer(sp.GetRequiredService<Library>(), new IPEndPoint(System.Net.Sockets.Socket.OSSupportsIPv6 ? IPAddress.IPv6Any : IPAddress.Any, peerPort), sp.GetRequiredService<ILogger<PeerServer>>()));
builder.Services.AddHostedService(sp => sp.GetRequiredService<PeerServer>());
if (builder.Configuration.GetValue("DnsSd", false))
{
    var advertise = builder.Configuration["AdvertiseAddress"] is { Length: > 0 } a ? IPAddress.Parse(a) : null;
    builder.Services.AddHostedService(sp => new DnsSd(sp.GetRequiredService<Library>(), peerPort, advertise, sp.GetRequiredService<ILogger<DnsSd>>()));
}

var app = builder.Build();
await app.Services.GetRequiredService<Library>().ScanAsync();

Uri Url(HttpRequest req, string path) => new($"{req.Scheme}://{req.Host}{req.PathBase}/{path}");

app.MapGet("/", (HttpRequest req, Library library) => library.Files.Select(f => new
{
    f.Name,
    f.Hash.ContentLength,
    f.Hash.PieceCount,
    f.Hash.HashOfHashes,
    f.Hash.ContentId,
    SwarmHash = f.SwarmKey,
    Url = Url(req, "files/" + f.Name),
    PiecesHashFileUrl = Url(req, "pieceshash/" + f.Name),
    IntegrityCheckInfo = f.IntegrityCheckInfo(Url(req, "pieceshash/" + f.Name)),
}));
app.MapGet("/files/{**name}", (string name, Library library) =>
    library.FindByName(name) is { } f ? Results.File(f.Path, "application/octet-stream", enableRangeProcessing: true) : Results.NotFound());
app.MapGet("/pieceshash/{**name}", (string name, Library library) =>
    library.FindByName(name) is { } f ? Results.Bytes(f.PhfBytes, "application/json") : Results.NotFound());
app.MapPost("/rescan", async (Library library) =>
{
    await library.ScanAsync();
    return Results.NoContent();
});
app.MapGet("/healthz", () => "ok");

await app.RunAsync();
return 0;

// Downloads a file from one peer, for example a Windows device from an array's peer list
static async Task<int> FetchAsync(IPEndPoint peer, string phfSource, string? output)
{
    using var http = new HttpClient();
    var json = phfSource.StartsWith("http", StringComparison.OrdinalIgnoreCase)
        ? await http.GetByteArrayAsync(phfSource)
        : await File.ReadAllBytesAsync(phfSource);
    var hash = JsonSerializer.Deserialize<PiecesHash>(json) ?? throw new InvalidDataException("Empty pieces hash file");
    if (!hash.IsValid())
        throw new InvalidDataException("HashOfHashes does not match the pieces");
    using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(5));
    await using var client = await SwarmClient.ConnectAsync(peer, hash, cts.Token);
    var have = Enumerable.Range(0, hash.PieceCount).Count(client.HasPiece);
    Console.WriteLine($"{peer}: peer id {Convert.ToHexString(client.Remote.PeerId)}, version {client.Remote.Version}, has {have}/{hash.PieceCount} pieces");
    await using var file = output is null ? null : File.Create(output);
    for (var i = 0; i < hash.PieceCount; i++)
    {
        if (!client.HasPiece(i))
        {
            if (file is not null)
                throw new InvalidDataException($"Peer lacks piece {i}");
            continue;
        }
        var piece = await client.GetPieceAsync(i, cts.Token);
        Console.WriteLine($"piece {i}: {piece.Length} bytes, SHA256 ok");
        if (file is null)
            return 0;
        file.Seek((long)i * hash.PieceSize, SeekOrigin.Begin);
        await file.WriteAsync(piece, cts.Token);
    }
    return 0;
}
