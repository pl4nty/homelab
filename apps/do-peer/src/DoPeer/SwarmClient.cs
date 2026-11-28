using System.Net;
using System.Net.Sockets;

namespace DoPeer;

// A downloading peer: joins one swarm on one peer and fetches pieces, checking each against the pieces hash file.
public sealed class SwarmClient : IAsyncDisposable
{
    const int BlockSize = 1 << 14;

    readonly TcpClient tcp;
    readonly Stream stream;
    readonly PiecesHash hash;

    public Handshake Remote { get; private set; } = null!;
    byte[] bitField = [];

    public ReadOnlySpan<byte> BitField => bitField;

    SwarmClient(TcpClient tcp, PiecesHash hash)
    {
        this.tcp = tcp;
        stream = tcp.GetStream();
        this.hash = hash;
    }

    public static async Task<SwarmClient> ConnectAsync(IPEndPoint peer, PiecesHash hash, CancellationToken ct)
    {
        var tcp = new TcpClient(peer.AddressFamily);
        await tcp.ConnectAsync(peer, ct);
        var client = new SwarmClient(tcp, hash);
        await client.stream.WriteAsync(Wire.EncodeHandshake(hash.SwarmHash, Wire.NewPeerId()), ct);
        client.Remote = await Wire.ReadHandshakeAsync(client.stream, ct);
        if (!client.Remote.SwarmHash.AsSpan().SequenceEqual(hash.SwarmHash))
            throw new InvalidDataException("Peer answered for another swarm");
        await Wire.WriteMessageAsync(client.stream, MessageId.Interested, [], ct);
        // wait for the peer's bitfield (or haves) and its unchoke
        var unchoked = false;
        while (!unchoked)
        {
            var msg = await Wire.ReadMessageAsync(client.stream, ct);
            switch (msg?.Id)
            {
                case MessageId.BitField:
                    client.bitField = msg.Payload;
                    break;
                case MessageId.Have:
                    client.SetHave((int)msg.UInt(0));
                    break;
                case MessageId.Unchoke:
                    unchoked = true;
                    break;
                default:
                    break;
            }
        }
        return client;
    }

    public bool HasPiece(int index) => Wire.HasPiece(BitField, index);

    // Requests a piece in 16 KiB blocks and returns it once its SHA256 matches the pieces hash file
    public async Task<byte[]> GetPieceAsync(int index, CancellationToken ct)
    {
        var length = (int)hash.PieceLength(index);
        var piece = new byte[length];
        for (var begin = 0; begin < length; begin += BlockSize)
            await Wire.WriteMessageAsync(stream, MessageId.Request, Wire.UInts((uint)index, (uint)begin, (uint)Math.Min(BlockSize, length - begin)), ct);
        var received = 0;
        while (received < length)
        {
            var msg = await Wire.ReadMessageAsync(stream, ct);
            switch (msg?.Id)
            {
                case MessageId.Piece when msg.UInt(0) == index:
                    var begin = (int)msg.UInt(4);
                    msg.Payload.AsSpan(8).CopyTo(piece.AsSpan(begin));
                    received += msg.Payload.Length - 8;
                    break;
                case MessageId.Choke:
                    throw new InvalidDataException("Peer choked us");
                case MessageId.Have:
                    SetHave((int)msg.UInt(0));
                    break;
                default:
                    break;
            }
        }
        if (!hash.CheckPiece(index, piece))
            throw new InvalidDataException($"Piece {index} failed its hash check");
        return piece;
    }

    void SetHave(int index)
    {
        if ((index >> 3) >= bitField.Length)
            Array.Resize(ref bitField, (index >> 3) + 1);
        bitField[index >> 3] |= (byte)(0x80 >> (index & 7));
    }

    public async ValueTask DisposeAsync()
    {
        await stream.DisposeAsync();
        tcp.Dispose();
    }
}
