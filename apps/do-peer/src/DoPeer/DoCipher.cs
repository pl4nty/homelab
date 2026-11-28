using System.Buffers.Binary;
using System.Security.Cryptography;

namespace DoPeer;

// DO's DecryptionInfo cipher, from doclient.dll's CCipher. The content is split into buffers of BufferSize
// bytes. Each buffer is AES-CBC on its own, with the IV set to AES-ECB of its offset (u64 little-endian, then
// zeros). Only the last buffer may carry PKCS7 padding.
public sealed class DoCipher(byte[] key, int bufferSize = DoCipher.DefaultBufferSize) : IDisposable
{
    public const int DefaultBufferSize = 0x10000;
    public const int MaxBufferSize = 0x100000;

    readonly Aes aes = Create(key, bufferSize);

    static Aes Create(byte[] key, int bufferSize)
    {
        if (bufferSize <= 0 || bufferSize > MaxBufferSize || bufferSize % 16 != 0)
            throw new ArgumentOutOfRangeException(nameof(bufferSize));
        var aes = Aes.Create();
        aes.Key = key;
        return aes;
    }

    public int BufferSize => bufferSize;

    // The JSON for DODownloadProperty_DecryptionInfo, read by CBackgroundCopyFile::_SetDecryptionInfo
    public object DecryptionInfo => new
    {
        KeyData = Convert.ToBase64String(key),
        EncryptionBufferSize = bufferSize,
        AlgorithmName = "AES",
        ChainingMode = "ChainingModeCBC",
    };

    public byte[] Iv(long offset)
    {
        var block = new byte[16];
        BinaryPrimitives.WriteInt64LittleEndian(block, offset);
        return aes.EncryptEcb(block, PaddingMode.None);
    }

    public byte[] Encrypt(ReadOnlySpan<byte> plain)
    {
        var padded = new byte[(plain.Length / 16 + 1) * 16];
        plain.CopyTo(padded);
        padded.AsSpan(plain.Length).Fill((byte)(padded.Length - plain.Length));
        for (var offset = 0; offset < padded.Length; offset += bufferSize)
        {
            var chunk = padded.AsSpan(offset, Math.Min(bufferSize, padded.Length - offset));
            aes.EncryptCbc(chunk, Iv(offset), chunk, PaddingMode.None);
        }
        return padded;
    }

    // CCipher::Decrypt: the last buffer is tried with padding first, then without
    public byte[] Decrypt(ReadOnlySpan<byte> cipher)
    {
        var plain = new MemoryStream();
        for (var offset = 0; offset < cipher.Length; offset += bufferSize)
        {
            var chunk = cipher.Slice(offset, Math.Min(bufferSize, cipher.Length - offset));
            var last = offset + chunk.Length == cipher.Length;
            byte[] output;
            try
            {
                output = aes.DecryptCbc(chunk, Iv(offset), last ? PaddingMode.PKCS7 : PaddingMode.None);
            }
            catch (CryptographicException) when (last)
            {
                output = aes.DecryptCbc(chunk, Iv(offset), PaddingMode.None);
            }
            plain.Write(output);
        }
        return plain.ToArray();
    }

    public void Dispose() => aes.Dispose();
}
