using System.Buffers.Binary;
using System.Diagnostics;
using System.Text;

namespace MsftUpdates.Sync;

/// <summary>
/// Large update XML arrives as a one-file LZX cabinet of UTF-16 text. .NET has no LZX decoder, so this
/// pipes it through cabextract.
/// </summary>
public static class Cabinet
{
    public static async Task<string> ExtractTextAsync(byte[] cabinet, CancellationToken ct)
    {
        var path = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.cab");
        await File.WriteAllBytesAsync(path, cabinet, ct);
        try
        {
            var start = new ProcessStartInfo("cabextract")
            {
                ArgumentList = { "--quiet", "--pipe", path },
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using var process = Process.Start(start) ?? throw new InvalidOperationException("cabextract did not start");
            var error = process.StandardError.ReadToEndAsync(ct);
            using var output = new MemoryStream(checked((int)UncompressedSize(cabinet)));
            await process.StandardOutput.BaseStream.CopyToAsync(output, ct);
            await process.WaitForExitAsync(ct);
            if (process.ExitCode != 0)
            {
                throw new InvalidDataException($"cabextract exited {process.ExitCode}: {await error}");
            }

            var text = output.GetBuffer().AsSpan(0, (int)output.Length);
            if (text is [0xFF, 0xFE, ..])
            {
                text = text[2..];
            }
            return Encoding.Unicode.GetString(text);
        }
        finally
        {
            File.Delete(path);
        }
    }

    /// <summary>The CFFILE sizes, read from the header without decompressing.</summary>
    public static long UncompressedSize(ReadOnlySpan<byte> cabinet)
    {
        var offset = BinaryPrimitives.ReadInt32LittleEndian(cabinet[16..]);
        var files = BinaryPrimitives.ReadUInt16LittleEndian(cabinet[28..]);
        long size = 0;
        for (var i = 0; i < files; i++)
        {
            size += BinaryPrimitives.ReadUInt32LittleEndian(cabinet[offset..]);
            offset += 16;
            offset += cabinet[offset..].IndexOf((byte)0) + 1;
        }
        return size;
    }
}
