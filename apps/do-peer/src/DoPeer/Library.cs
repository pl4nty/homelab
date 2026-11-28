using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json;

namespace DoPeer;

public sealed record SharedFile(string Name, string Path, PiecesHash Hash, byte[] PhfBytes)
{
    public string SwarmKey => Convert.ToHexString(Hash.SwarmHash);

    // DODownloadProperty_IntegrityCheckInfo, read by CBackgroundCopyFile::_SetPhfInfo
    public object IntegrityCheckInfo(Uri phfUrl) => new
    {
        PiecesHashFileUrl = phfUrl.ToString(),
        Hash.HashOfHashes,
        PiecesHashFileDigest = Convert.ToBase64String(SHA256.HashData(PhfBytes)),
        PiecesHashFileDigestAlgorithm = "SHA256",
    };
}

// Every file in a folder, indexed by swarm hash (its HashOfHashes), the infohash peers send in the handshake.
public sealed class Library(string root, ILogger<Library> log)
{
    readonly ConcurrentDictionary<string, SharedFile> bySwarm = new();
    readonly ConcurrentDictionary<string, SharedFile> byName = new(StringComparer.OrdinalIgnoreCase);

    public string Root { get; } = Path.GetFullPath(root);

    public IEnumerable<SharedFile> Files => byName.Values.OrderBy(f => f.Name);

    public SharedFile? FindBySwarm(ReadOnlySpan<byte> swarmHash) => bySwarm.GetValueOrDefault(Convert.ToHexString(swarmHash));

    public SharedFile? FindByName(string name) => byName.GetValueOrDefault(name);

    public async Task ScanAsync(CancellationToken ct = default)
    {
        Directory.CreateDirectory(Root);
        foreach (var path in Directory.EnumerateFiles(Root, "*", SearchOption.AllDirectories))
        {
            var name = Path.GetRelativePath(Root, path).Replace('\\', '/');
            if (byName.ContainsKey(name))
                continue;
            await using var stream = File.OpenRead(path);
            var hash = await PiecesHash.ComputeAsync(stream, ct: ct);
            var file = new SharedFile(name, path, hash, JsonSerializer.SerializeToUtf8Bytes(hash));
            byName[name] = file;
            bySwarm[file.SwarmKey] = file;
            log.LogInformation("Sharing {Name}: {Length} bytes, {Pieces} pieces, {ContentId}", name, hash.ContentLength, hash.PieceCount, hash.ContentId);
        }
    }
}
