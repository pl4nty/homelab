using System.Security.Cryptography;
using Microsoft.Extensions.Logging;

namespace WinGet.RestSource;

/// <summary>
/// An installer shim executable served by the host, hashed once at startup so manifests can pin it.
/// </summary>
public sealed class ShimFile
{
    private ShimFile(string path, byte[]? bytes)
    {
        FileName = Path.GetFileName(path);
        Bytes = bytes;
        Sha256 = bytes is null ? null : Convert.ToHexString(SHA256.HashData(bytes));
    }

    public string FileName { get; }

    public byte[]? Bytes { get; }

    public string? Sha256 { get; }

    public static ShimFile Load(string path, ILogger logger)
    {
        if (!File.Exists(path))
        {
            // Search still works; manifests cannot be served because installers need the shim's URL and hash.
            logger.LogWarning(
                "Shim not found at {ShimPath}; the source's /packageManifests will return no data. " +
                "Publish the shim project for win-x64 and place it there.", path);
            return new ShimFile(path, null);
        }

        return new ShimFile(path, File.ReadAllBytes(path));
    }
}
