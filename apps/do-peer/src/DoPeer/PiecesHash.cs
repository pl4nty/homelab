using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text.Json.Serialization;

namespace DoPeer;

// The pieces hash file (PHF) that DO downloads beside a file, in the shape of
// dl.delivery.mp.microsoft.com/filestreamingservice/files/<guid>/pieceshash.
public sealed record PiecesHash(
    ushort MajorVersion,
    ushort MinorVersion,
    string HashOfHashes,
    long ContentLength,
    int PieceSize,
    string[] Pieces)
{
    // CMetaInfo::CreateFromBuf rejects pieces over 1 MiB, the size Microsoft's files use.
    public const int DefaultPieceSize = 1 << 20;

    [JsonIgnore]
    public byte[] SwarmHash => Convert.FromBase64String(HashOfHashes);

    // The ContentId the content policy service hands out: "DO-" and the base64 HashOfHashes with padding, '+' as '_'
    // and '/' as '-' (the reverse of base64url): HashOfHashes gG3/TutV…Zk/zEGq… is DO-gG3-TutV…Zk-zEGq….
    [JsonIgnore]
    public string ContentId => "DO-" + HashOfHashes.Replace('+', '_').Replace('/', '-');

    [JsonIgnore]
    public int PieceCount => Pieces.Length;

    public long PieceLength(int index) => Math.Min(PieceSize, ContentLength - (long)index * PieceSize);

    public static async Task<PiecesHash> ComputeAsync(Stream content, int pieceSize = DefaultPieceSize, CancellationToken ct = default)
    {
        var pieces = new List<string>();
        var buffer = new byte[pieceSize];
        long length = 0;
        int read;
        while ((read = await content.ReadAtLeastAsync(buffer, pieceSize, throwOnEndOfStream: false, ct)) > 0)
        {
            pieces.Add(Convert.ToBase64String(SHA256.HashData(buffer.AsSpan(0, read))));
            length += read;
        }
        return new PiecesHash(1, 0, Convert.ToBase64String(ComputeHashOfHashes(1, 0, length, pieceSize, pieces)), length, pieceSize, [.. pieces]);
    }

    // CMetaInfo::_CheckHashes: SHA256 over MajorVersion (u16), MinorVersion (u16), ContentLength (u64),
    // PieceSize (u32), little-endian, then each piece's SHA256.
    public static byte[] ComputeHashOfHashes(ushort major, ushort minor, long contentLength, int pieceSize, IEnumerable<string> pieces)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Span<byte> header = stackalloc byte[16];
        BinaryPrimitives.WriteUInt16LittleEndian(header, major);
        BinaryPrimitives.WriteUInt16LittleEndian(header[2..], minor);
        BinaryPrimitives.WriteInt64LittleEndian(header[4..], contentLength);
        BinaryPrimitives.WriteInt32LittleEndian(header[12..], pieceSize);
        hash.AppendData(header);
        foreach (var piece in pieces)
            hash.AppendData(Convert.FromBase64String(piece));
        return hash.GetHashAndReset();
    }

    public bool IsValid() =>
        ComputeHashOfHashes(MajorVersion, MinorVersion, ContentLength, PieceSize, Pieces).AsSpan().SequenceEqual(SwarmHash);

    public bool CheckPiece(int index, ReadOnlySpan<byte> data) =>
        SHA256.HashData(data).AsSpan().SequenceEqual(Convert.FromBase64String(Pieces[index]));
}
