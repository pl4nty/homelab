using System.Buffers.Binary;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;

namespace DoPeer;

// Advertises the peer the way CDnsPeerRegistrar does, so Windows devices that find peers with DNS-SD
// (DORestrictPeerSelectionBy 2, or the default where DO rolls it out) connect without the DO cloud services:
// instance <host>._dosvc._tcp.local on the peer port, with TXT SH00, SH01… = the first 16 characters of each
// swarm hash in base64, and P = device profile. CDnsPeerSearcher skips records without P, and those whose
// G (group ID) differs from its own.
public sealed class DnsSd(Library library, int peerPort, IPAddress? advertise, ILogger<DnsSd> log) : BackgroundService
{
    const string Service = "_dosvc._tcp.local";
    const ushort A = 1, Ptr = 12, Txt = 16, Srv = 33, Any = 255;
    const uint Ttl = 120;

    static readonly IPEndPoint Group = new(IPAddress.Parse("224.0.0.251"), 5353);

    readonly string host = Dns.GetHostName().Split('.')[0].ToLowerInvariant();

    string Instance => $"{host}.{Service}";

    string HostName => $"{host}.local";

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        using var udp = new UdpClient(AddressFamily.InterNetwork);
        udp.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
        udp.Client.Bind(new IPEndPoint(IPAddress.Any, Group.Port));
        udp.JoinMulticastGroup(Group.Address);
        log.LogInformation("Advertising {Instance} on port {Port}", Instance, peerPort);
        await udp.SendAsync(Response(), Group, ct);
        while (!ct.IsCancellationRequested)
        {
            var packet = await udp.ReceiveAsync(ct);
            if (Asks(packet.Buffer))
                await udp.SendAsync(Response(), Group, ct);
        }
    }

    // a query (QR bit clear) with a question for the service, the instance or the host
    public bool Asks(byte[] msg)
    {
        try
        {
            if (msg.Length < 12 || (msg[2] & 0x80) != 0)
                return false;
            var questions = BinaryPrimitives.ReadUInt16BigEndian(msg.AsSpan(4));
            var offset = 12;
            for (var i = 0; i < questions; i++)
            {
                var name = ReadName(msg, ref offset);
                var type = BinaryPrimitives.ReadUInt16BigEndian(msg.AsSpan(offset));
                offset += 4;
                if ((name.Equals(Service, StringComparison.OrdinalIgnoreCase) && type is Ptr or Any)
                    || (name.Equals(Instance, StringComparison.OrdinalIgnoreCase) && type is Srv or Txt or Any)
                    || (name.Equals(HostName, StringComparison.OrdinalIgnoreCase) && type is A or Any))
                    return true;
            }
        }
        catch (Exception e) when (e is IndexOutOfRangeException or ArgumentOutOfRangeException)
        {
        }
        return false;
    }

    public byte[] Response()
    {
        var txt = new List<string> { "P=0" };
        txt.AddRange(library.Files.Take(256).Select((f, i) => $"SH{i:x2}={f.Hash.HashOfHashes[..16]}"));
        var addresses = advertise is null ? LocalAddresses() : [advertise];
        var records = new List<byte[]>
        {
            Record(Service, Ptr, false, Name(Instance)),
            Record(Instance, Srv, true, [.. UShort(0), .. UShort(0), .. UShort((ushort)peerPort), .. Name(HostName)]),
            Record(Instance, Txt, true, [.. txt.SelectMany(t => (byte[])[(byte)t.Length, .. Encoding.ASCII.GetBytes(t)])]),
        };
        records.AddRange(addresses.Select(a => Record(HostName, A, true, a.GetAddressBytes())));
        // response, authoritative; every record goes in the answer section
        byte[] header = [0, 0, 0x84, 0, 0, 0, .. UShort((ushort)records.Count), 0, 0, 0, 0];
        return [.. header, .. records.SelectMany(r => r)];
    }

    static IEnumerable<IPAddress> LocalAddresses() =>
        NetworkInterface.GetAllNetworkInterfaces()
            .Where(n => n.OperationalStatus == OperationalStatus.Up && n.NetworkInterfaceType != NetworkInterfaceType.Loopback)
            .SelectMany(n => n.GetIPProperties().UnicastAddresses)
            .Select(u => u.Address)
            .Where(a => a.AddressFamily == AddressFamily.InterNetwork);

    static byte[] Record(string name, ushort type, bool unique, byte[] data) =>
        [.. Name(name), .. UShort(type), .. UShort((ushort)(unique ? 0x8001 : 1)), .. UInt(Ttl), .. UShort((ushort)data.Length), .. data];

    static byte[] Name(string name) =>
        [.. name.Split('.').SelectMany(l => (byte[])[(byte)l.Length, .. Encoding.UTF8.GetBytes(l)]), 0];

    static byte[] UShort(ushort v) => [(byte)(v >> 8), (byte)v];

    static byte[] UInt(uint v) => [(byte)(v >> 24), (byte)(v >> 16), (byte)(v >> 8), (byte)v];

    static string ReadName(byte[] msg, ref int offset)
    {
        var labels = new List<string>();
        var pos = offset;
        var jumped = false;
        for (var hops = 0; hops < 64; hops++)
        {
            var len = msg[pos];
            if (len == 0)
            {
                if (!jumped)
                    offset = pos + 1;
                return string.Join('.', labels);
            }
            if ((len & 0xc0) == 0xc0)
            {
                if (!jumped)
                    offset = pos + 2;
                jumped = true;
                pos = ((len & 0x3f) << 8) | msg[pos + 1];
                continue;
            }
            labels.Add(Encoding.UTF8.GetString(msg, pos + 1, len));
            pos += len + 1;
        }
        throw new IndexOutOfRangeException("DNS name loop");
    }
}
