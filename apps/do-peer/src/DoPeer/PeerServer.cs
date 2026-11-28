using System.Net;
using System.Net.Sockets;
using Microsoft.Win32.SafeHandles;

namespace DoPeer;

// Seeds every file in the library to DO peers that connect on TCP 7680.
public sealed class PeerServer(Library library, IPEndPoint endpoint, ILogger<PeerServer> log) : BackgroundService
{
    static readonly TimeSpan KeepAlive = TimeSpan.FromSeconds(60);

    readonly TaskCompletionSource<IPEndPoint> listening = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public byte[] PeerId { get; } = Wire.NewPeerId();

    public Task<IPEndPoint> Listening => listening.Task;

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        using var listener = new TcpListener(endpoint);
        if (endpoint.Address.Equals(IPAddress.IPv6Any))
            listener.Server.DualMode = true;
        listener.Start();
        listening.TrySetResult((IPEndPoint)listener.LocalEndpoint);
        log.LogInformation("Peer listening on {Endpoint}", listener.LocalEndpoint);
        while (!ct.IsCancellationRequested)
        {
            var client = await listener.AcceptTcpClientAsync(ct);
            _ = Task.Run(() => ServeAsync(client, ct), ct);
        }
    }

    async Task ServeAsync(TcpClient client, CancellationToken ct)
    {
        var remote = client.Client.RemoteEndPoint;
        using (client)
        {
            try
            {
                await using var stream = client.GetStream();
                var (reserved, swarmHash) = await Wire.ReadPartialHandshakeAsync(stream, ct);
                var file = library.FindBySwarm(swarmHash);
                if (file is null)
                {
                    log.LogInformation("{Remote} asked for unknown swarm {Swarm}", remote, Convert.ToHexString(swarmHash));
                    return;
                }
                var version = Math.Min(reserved[0], (byte)1);
                await stream.WriteAsync(Wire.EncodeHandshake(swarmHash, PeerId, version), ct);
                var peerId = await Wire.ReadPeerIdAsync(stream, ct);
                log.LogInformation("{Remote} (peer {PeerId}, version {Version}) joined {Name}", remote, Convert.ToHexString(peerId), reserved[0], file.Name);
                await new Session(stream, file).RunAsync(ct);
            }
            catch (Exception e) when (e is IOException or InvalidDataException or EndOfStreamException or OperationCanceledException)
            {
                log.LogDebug("{Remote}: {Error}", remote, e.Message);
            }
            log.LogInformation("{Remote} disconnected", remote);
        }
    }

    sealed class Session(Stream stream, SharedFile file)
    {
        readonly SemaphoreSlim writeLock = new(1, 1);

        public async Task RunAsync(CancellationToken ct)
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            using var handle = File.OpenHandle(file.Path, FileMode.Open, FileAccess.Read, FileShare.Read, FileOptions.RandomAccess);
            await SendAsync(MessageId.BitField, Wire.FullBitField(file.Hash.PieceCount), cts.Token);
            var keepAlive = KeepAliveAsync(cts.Token);
            try
            {
                while (true)
                {
                    var msg = await Wire.ReadMessageAsync(stream, cts.Token);
                    switch (msg?.Id)
                    {
                        case MessageId.Interested:
                            await SendAsync(MessageId.Unchoke, [], cts.Token);
                            break;
                        case MessageId.Request when msg.Payload.Length == 12:
                            await SendPieceAsync(handle, msg.UInt(0), msg.UInt(4), msg.UInt(8), cts.Token);
                            break;
                        // requests are answered at once, so there is nothing to cancel; other messages need no reply
                        default:
                            break;
                    }
                }
            }
            finally
            {
                await cts.CancelAsync();
                await keepAlive.ContinueWith(_ => { }, CancellationToken.None);
            }
        }

        async Task SendPieceAsync(SafeFileHandle handle, uint index, uint begin, uint length, CancellationToken ct)
        {
            // CSwarmConn::_CheckBlockValidity: the block must lie inside the piece
            if (index >= file.Hash.PieceCount || length == 0 || length > Wire.MaxMessageLength - 9 || (long)begin + length > file.Hash.PieceLength((int)index))
                throw new InvalidDataException($"Invalid request: piece {index}, offset {begin}, length {length}");
            var payload = new byte[8 + length];
            Wire.UInts(index, begin).CopyTo(payload, 0);
            await RandomAccess.ReadAsync(handle, payload.AsMemory(8), (long)index * file.Hash.PieceSize + begin, ct);
            await SendAsync(MessageId.Piece, payload, ct);
        }

        async Task SendAsync(MessageId id, byte[] payload, CancellationToken ct)
        {
            await writeLock.WaitAsync(ct);
            try { await Wire.WriteMessageAsync(stream, id, payload, ct); }
            finally { writeLock.Release(); }
        }

        async Task KeepAliveAsync(CancellationToken ct)
        {
            using var timer = new PeriodicTimer(KeepAlive);
            while (await timer.WaitForNextTickAsync(ct))
            {
                await writeLock.WaitAsync(ct);
                try { await Wire.WriteKeepAliveAsync(stream, ct); }
                finally { writeLock.Release(); }
            }
        }
    }
}
