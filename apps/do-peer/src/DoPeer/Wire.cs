using System.Buffers.Binary;
using System.Text;

namespace DoPeer;

// The DO peer protocol on TCP 7680, from doclient.dll's CPeerSock. It is BitTorrent's wire protocol with
// its own protocol string, a 32-byte infohash (the swarm hash) and one extra message, DoNotHave.
public enum MessageId : byte
{
    Choke = 0,
    Unchoke = 1,
    Interested = 2,
    NotInterested = 3,
    Have = 4,
    BitField = 5,
    Request = 6,
    Piece = 7,
    Cancel = 8,
    DoNotHave = 10,
    Extended = 20,
}

public sealed record Handshake(byte Version, byte[] Reserved, byte[] SwarmHash, byte[] PeerId);

public sealed record Message(MessageId Id, byte[] Payload)
{
    public uint UInt(int offset) => BinaryPrimitives.ReadUInt32BigEndian(Payload.AsSpan(offset));
}

public static class Wire
{
    public const string Protocol = "Swarm protocol";
    public const int HashLength = 32;
    public const int PeerIdLength = 20;

    // CPeerSock::_ProcessBytes drops a message longer than this
    public const int MaxMessageLength = 0x1f4000;

    static readonly byte[] ProtocolBytes = Encoding.ASCII.GetBytes(Protocol);

    // CPeerSock::SendHandShake: reserved byte 0 is the protocol version (CPeerSock starts at 1, and each side
    // keeps the lower of the two), reserved byte 5 is 0x10.
    public static byte[] EncodeHandshake(ReadOnlySpan<byte> swarmHash, ReadOnlySpan<byte> peerId, byte version = 1)
    {
        var buf = new byte[1 + ProtocolBytes.Length + 8 + HashLength + PeerIdLength];
        buf[0] = (byte)ProtocolBytes.Length;
        ProtocolBytes.CopyTo(buf, 1);
        var reserved = 1 + ProtocolBytes.Length;
        buf[reserved] = version;
        buf[reserved + 5] = 0x10;
        swarmHash.CopyTo(buf.AsSpan(reserved + 8));
        peerId.CopyTo(buf.AsSpan(reserved + 8 + HashLength));
        return buf;
    }

    // The client reads the protocol string, reserved bytes and swarm hash first, answers once it knows the
    // swarm, then reads the 20-byte peer id.
    public static async Task<(byte[] Reserved, byte[] SwarmHash)> ReadPartialHandshakeAsync(Stream s, CancellationToken ct)
    {
        var len = await ReadExactAsync(s, 1, ct);
        if (len[0] != ProtocolBytes.Length)
            throw new InvalidDataException($"Invalid protocol size: {len[0]}");
        var rest = await ReadExactAsync(s, len[0] + 8 + HashLength, ct);
        if (!rest.AsSpan(0, len[0]).SequenceEqual(ProtocolBytes))
            throw new InvalidDataException("Unknown protocol: " + Encoding.ASCII.GetString(rest, 0, len[0]));
        return (rest[len[0]..(len[0] + 8)], rest[(len[0] + 8)..]);
    }

    public static Task<byte[]> ReadPeerIdAsync(Stream s, CancellationToken ct) => ReadExactAsync(s, PeerIdLength, ct);

    public static async Task<Handshake> ReadHandshakeAsync(Stream s, CancellationToken ct)
    {
        var (reserved, hash) = await ReadPartialHandshakeAsync(s, ct);
        return new Handshake(reserved[0], reserved, hash, await ReadPeerIdAsync(s, ct));
    }

    // 4-byte big-endian length, then the message id; length 0 is a keep-alive (null here)
    public static async Task<Message?> ReadMessageAsync(Stream s, CancellationToken ct)
    {
        var len = BinaryPrimitives.ReadUInt32BigEndian(await ReadExactAsync(s, 4, ct));
        if (len == 0)
            return null;
        if (len > MaxMessageLength)
            throw new InvalidDataException($"Message too big: {len}");
        var body = await ReadExactAsync(s, (int)len, ct);
        return new Message((MessageId)body[0], body[1..]);
    }

    public static ValueTask WriteMessageAsync(Stream s, MessageId id, ReadOnlySpan<byte> payload, CancellationToken ct)
    {
        var buf = new byte[5 + payload.Length];
        BinaryPrimitives.WriteUInt32BigEndian(buf, (uint)(1 + payload.Length));
        buf[4] = (byte)id;
        payload.CopyTo(buf.AsSpan(5));
        return s.WriteAsync(buf, ct);
    }

    public static ValueTask WriteKeepAliveAsync(Stream s, CancellationToken ct) => s.WriteAsync(new byte[4], ct);

    public static byte[] UInts(params uint[] values)
    {
        var buf = new byte[values.Length * 4];
        for (var i = 0; i < values.Length; i++)
            BinaryPrimitives.WriteUInt32BigEndian(buf.AsSpan(i * 4), values[i]);
        return buf;
    }

    // CBitField: piece 0 is the high bit of byte 0
    public static byte[] FullBitField(int pieces)
    {
        var bits = new byte[(pieces + 7) / 8];
        for (var i = 0; i < pieces; i++)
            bits[i >> 3] |= (byte)(0x80 >> (i & 7));
        return bits;
    }

    public static bool HasPiece(ReadOnlySpan<byte> bitField, int index) =>
        (index >> 3) < bitField.Length && (bitField[index >> 3] & (0x80 >> (index & 7))) != 0;

    // CPeerId is 20 bytes; the peer ids arrays return end in four zero bytes
    public static byte[] NewPeerId()
    {
        var id = new byte[PeerIdLength];
        Guid.NewGuid().TryWriteBytes(id);
        return id;
    }

    static async Task<byte[]> ReadExactAsync(Stream s, int count, CancellationToken ct)
    {
        var buf = new byte[count];
        await s.ReadExactlyAsync(buf, ct);
        return buf;
    }
}
