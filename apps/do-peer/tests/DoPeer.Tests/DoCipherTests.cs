using System.Security.Cryptography;
using DoPeer;
using Xunit;

namespace DoPeer.Tests;

public class DoCipherTests
{
    [Theory]
    [InlineData(0)]
    [InlineData(15)]
    [InlineData(16)]
    [InlineData(DoCipher.DefaultBufferSize)]
    [InlineData(3 * DoCipher.DefaultBufferSize + 123)]
    public void RoundTrips(int length)
    {
        var plain = RandomNumberGenerator.GetBytes(length);
        using var cipher = new DoCipher(RandomNumberGenerator.GetBytes(32));
        var encrypted = cipher.Encrypt(plain);
        Assert.Equal(0, encrypted.Length % 16);
        Assert.Equal(plain, cipher.Decrypt(encrypted));
    }

    [Fact]
    public void EachBufferDecryptsOnItsOwn()
    {
        var plain = RandomNumberGenerator.GetBytes(2 * DoCipher.DefaultBufferSize);
        var key = RandomNumberGenerator.GetBytes(16);
        using var cipher = new DoCipher(key);
        var encrypted = cipher.Encrypt(plain);
        using var aes = Aes.Create();
        aes.Key = key;
        var second = aes.DecryptCbc(encrypted.AsSpan(DoCipher.DefaultBufferSize, DoCipher.DefaultBufferSize), cipher.Iv(DoCipher.DefaultBufferSize), PaddingMode.None);
        Assert.Equal(plain[DoCipher.DefaultBufferSize..], second);
    }

    [Fact]
    public void UnpaddedLastBufferIsAccepted()
    {
        var plain = RandomNumberGenerator.GetBytes(48);
        // a last byte of 1 would read as valid padding, and DO would drop it too
        plain[^1] = 0;
        var key = RandomNumberGenerator.GetBytes(16);
        using var cipher = new DoCipher(key);
        using var aes = Aes.Create();
        aes.Key = key;
        var encrypted = aes.EncryptCbc(plain, cipher.Iv(0), PaddingMode.None);
        Assert.Equal(plain, cipher.Decrypt(encrypted));
    }

    [Fact]
    public void RejectsBufferSizeOverOneMiB() =>
        Assert.Throws<ArgumentOutOfRangeException>(() => new DoCipher(new byte[16], DoCipher.MaxBufferSize + 16));
}
