using System.Text.Json;
using DoPeer;
using Xunit;

namespace DoPeer.Tests;

public class PiecesHashTests
{
    // dl.delivery.mp.microsoft.com/filestreamingservice/files/<guid>/pieceshash, for the content policy
    // ContentId DO-eyxrh30Cyga9966q4YNz6hR_0Twbl42N6xiDoGMh_1E=
    static PiecesHash Microsoft() => JsonSerializer.Deserialize<PiecesHash>(File.ReadAllBytes("Fixtures/pieceshash.json"))!;

    [Fact]
    public void HashOfHashesMatchesMicrosoftFile()
    {
        var hash = Microsoft();
        Assert.True(hash.IsValid());
        Assert.Equal("DO-eyxrh30Cyga9966q4YNz6hR_0Twbl42N6xiDoGMh_1E=", hash.ContentId);
    }

    [Fact]
    public void ContentIdSwapsBase64Symbols()
    {
        // KB5043080's content policy answer for HashOfHashes gG3/TutVp8m7ZkDPJqZ/zEGqy7aTNSrCXkc4RSsiYRs=
        var hash = new PiecesHash(1, 0, "gG3/TutVp8m7ZkDPJqZ/zEGqy7aTNSrCXkc4RSsiYRs=", 0, PiecesHash.DefaultPieceSize, []);
        Assert.Equal("DO-gG3-TutVp8m7ZkDPJqZ-zEGqy7aTNSrCXkc4RSsiYRs=", hash.ContentId);
    }

    [Fact]
    public void TamperedPieceFailsHashOfHashes()
    {
        var hash = Microsoft();
        var pieces = (string[])hash.Pieces.Clone();
        pieces[0] = pieces[1];
        Assert.False((hash with { Pieces = pieces }).IsValid());
    }

    [Fact]
    public async Task ComputesPiecesForAnyFile()
    {
        var data = new byte[(2 * PiecesHash.DefaultPieceSize) + 12345];
        Random.Shared.NextBytes(data);
        var hash = await PiecesHash.ComputeAsync(new MemoryStream(data));
        Assert.Equal(3, hash.PieceCount);
        Assert.Equal(12345, hash.PieceLength(2));
        Assert.True(hash.IsValid());
        Assert.True(hash.CheckPiece(2, data.AsSpan(2 * PiecesHash.DefaultPieceSize)));
        Assert.False(hash.CheckPiece(1, data.AsSpan(2 * PiecesHash.DefaultPieceSize)));
    }
}
