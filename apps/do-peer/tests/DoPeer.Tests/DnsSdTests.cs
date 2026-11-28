using System.Text;
using DoPeer;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace DoPeer.Tests;

public class DnsSdTests
{
    [Fact]
    public async Task AnswersServiceQueryWithSwarmHashes()
    {
        var root = Directory.CreateTempSubdirectory("do-peer").FullName;
        await File.WriteAllTextAsync(Path.Combine(root, "a.txt"), "hello");
        var library = new Library(root, NullLogger<Library>.Instance);
        await library.ScanAsync();
        var dnsSd = new DnsSd(library, 7680, System.Net.IPAddress.Parse("192.0.2.10"), NullLogger<DnsSd>.Instance);

        // PTR query for _dosvc._tcp.local, as DnsServiceBrowse sends it
        byte[] query = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 6, .. "_dosvc"u8, 4, .. "_tcp"u8, 5, .. "local"u8, 0, 0, 12, 0, 1];
        Assert.True(dnsSd.Asks(query));
        query[^3] = 1;
        Assert.False(dnsSd.Asks(query));

        var response = Encoding.ASCII.GetString(dnsSd.Response());
        Assert.Contains("P=0", response);
        Assert.Contains("SH00=" + library.Files.Single().Hash.HashOfHashes[..16], response);
        Directory.Delete(root, true);
    }
}
