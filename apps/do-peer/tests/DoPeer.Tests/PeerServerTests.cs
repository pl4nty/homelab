using System.Net;
using System.Net.Sockets;
using DoPeer;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace DoPeer.Tests;

public sealed class PeerServerTests : IAsyncLifetime
{
    readonly string root = Directory.CreateTempSubdirectory("do-peer").FullName;
    readonly byte[] data = new byte[(3 * PiecesHash.DefaultPieceSize) + 999];
    readonly CancellationTokenSource cts = new(TimeSpan.FromMinutes(1));
    Library library = null!;
    PeerServer server = null!;
    IPEndPoint endpoint = null!;

    public async Task InitializeAsync()
    {
        Random.Shared.NextBytes(data);
        await File.WriteAllBytesAsync(Path.Combine(root, "payload.bin"), data);
        library = new Library(root, NullLogger<Library>.Instance);
        await library.ScanAsync();
        server = new PeerServer(library, new IPEndPoint(IPAddress.Loopback, 0), NullLogger<PeerServer>.Instance);
        await server.StartAsync(cts.Token);
        endpoint = await server.Listening;
    }

    public async Task DisposeAsync()
    {
        await server.StopAsync(CancellationToken.None);
        cts.Dispose();
        Directory.Delete(root, true);
    }

    [Fact]
    public void HandshakeLayoutMatchesClient()
    {
        var hs = Wire.EncodeHandshake(new byte[32], new byte[20]);
        Assert.Equal(1 + 14 + 8 + 32 + 20, hs.Length);
        Assert.Equal(14, hs[0]);
        Assert.Equal("Swarm protocol", System.Text.Encoding.ASCII.GetString(hs, 1, 14));
        Assert.Equal(1, hs[15]);
        Assert.Equal(0x10, hs[20]);
    }

    [Fact]
    public async Task ServesEveryPiece()
    {
        var hash = library.FindByName("payload.bin")!.Hash;
        await using var client = await SwarmClient.ConnectAsync(endpoint, hash, cts.Token);
        Assert.Equal(server.PeerId, client.Remote.PeerId);
        Assert.Equal(1, client.Remote.Version);
        var received = new MemoryStream();
        for (var i = 0; i < hash.PieceCount; i++)
        {
            Assert.True(client.HasPiece(i));
            received.Write(await client.GetPieceAsync(i, cts.Token));
        }
        Assert.Equal(data, received.ToArray());
    }

    [Fact]
    public async Task DropsUnknownSwarm()
    {
        using var tcp = new TcpClient();
        await tcp.ConnectAsync(endpoint, cts.Token);
        var stream = tcp.GetStream();
        await stream.WriteAsync(Wire.EncodeHandshake(new byte[32], Wire.NewPeerId()), cts.Token);
        await Assert.ThrowsAsync<EndOfStreamException>(() => Wire.ReadHandshakeAsync(stream, cts.Token));
    }

    [Fact]
    public async Task RejectsBlockOutsidePiece()
    {
        var hash = library.FindByName("payload.bin")!.Hash;
        using var tcp = new TcpClient();
        await tcp.ConnectAsync(endpoint, cts.Token);
        var stream = tcp.GetStream();
        await stream.WriteAsync(Wire.EncodeHandshake(hash.SwarmHash, Wire.NewPeerId()), cts.Token);
        await Wire.ReadHandshakeAsync(stream, cts.Token);
        await Wire.WriteMessageAsync(stream, MessageId.Request, Wire.UInts(3, 0, 1000), cts.Token);
        // bitfield, then the server hangs up on the bad request
        Assert.Equal(MessageId.BitField, (await Wire.ReadMessageAsync(stream, cts.Token))!.Id);
        await Assert.ThrowsAsync<EndOfStreamException>(() => Wire.ReadMessageAsync(stream, cts.Token));
    }
}
