// The installer WinGet downloads from the REST source for every update package. WinGet has no msu/cab
// installer type, so this shim carries the real payload's location and digest in the manifest's
// InstallerSwitches.Custom, downloads it, verifies it, and hands it to the component that owns it:
//
//   winget-update-shim.exe /type:msu /url:https://catalog.s.download.windowsupdate.com/... /sha256:<base64|hex> /name:<file>
//   (/sha1:<base64|hex> instead, for the cumulative updates the catalog publishes only a SHA-1 digest for)
//   → wusa.exe <file> /quiet /norestart
//   winget-update-shim.exe /type:cab ... /driver   → expand + pnputil.exe /add-driver <dir>\*.inf /subdirs /install
//   winget-update-shim.exe /type:cab ...           → dism.exe /online /add-package /packagepath:<file> /quiet /norestart
//
// Exit code is the installer's (0, or 3010 when a reboot is pending); 87 (ERROR_INVALID_PARAMETER) for bad
// arguments, 13 (ERROR_INVALID_DATA) when the payload does not match the catalog digest.

using System.Diagnostics;
using System.Security.Cryptography;

const int InvalidParameter = 87;
const int InvalidData = 13;

string? type = null, url = null, sha256 = null, sha1 = null, name = null;
var driver = false;
foreach (var arg in args)
{
    // WinGet appends switches like /quiet; anything unknown is ignored.
    driver |= arg.Equals("/driver", StringComparison.OrdinalIgnoreCase);
    _ = Take(arg, "/type:", ref type) || Take(arg, "/url:", ref url)
        || Take(arg, "/sha256:", ref sha256) || Take(arg, "/sha1:", ref sha1) || Take(arg, "/name:", ref name);
}

if (type is not ("msu" or "cab")
    || !Uri.TryCreate(url, UriKind.Absolute, out var payloadUri) || payloadUri.Scheme != Uri.UriSchemeHttps
    || !TrustedHost(payloadUri.Host)
    || (Digest(sha256, SHA256.HashSizeInBytes) ?? Digest(sha1, SHA1.HashSizeInBytes)) is not { } expected)
{
    Console.Error.WriteLine(
        "usage: winget-update-shim.exe /type:msu|cab /url:<https-microsoft-url> /sha256:<base64|hex>|/sha1:<base64|hex> [/name:<file>] [/driver]");
    return InvalidParameter;
}

var directory = Path.Combine(Path.GetTempPath(), "winget-update-shim", Guid.NewGuid().ToString("n"));
Directory.CreateDirectory(directory);

try
{
    var payload = Path.Combine(directory, $"{Path.GetFileNameWithoutExtension(Path.GetFileName(name ?? "update"))}.{type}");

    using (var http = new HttpClient())
    {
        Console.WriteLine($"Downloading {payloadUri}");
        await using var download = await http.GetStreamAsync(payloadUri);
        await using var file = File.Create(payload);
        await download.CopyToAsync(file);
    }

    byte[] actual;
    await using (var file = File.OpenRead(payload))
    {
        actual = expected.Length == SHA256.HashSizeInBytes
            ? await SHA256.HashDataAsync(file)
            : await SHA1.HashDataAsync(file);
    }

    if (!actual.SequenceEqual(expected))
    {
        Console.Error.WriteLine(
            $"Digest mismatch: expected {Convert.ToHexString(expected)}, downloaded {Convert.ToHexString(actual)}");
        return InvalidData;
    }

    var system = Environment.SystemDirectory;
    if (type == "msu")
    {
        return await RunAsync(Path.Combine(system, "wusa.exe"), $"\"{payload}\" /quiet /norestart");
    }

    if (!driver)
    {
        return await RunAsync(Path.Combine(system, "dism.exe"),
            $"/online /add-package /packagepath:\"{payload}\" /norestart /quiet");
    }

    // Driver cabs carry INF-based packages; expand them and let PnP pick the applicable drivers.
    var expanded = Path.Combine(directory, "drivers");
    Directory.CreateDirectory(expanded);
    var expand = await RunAsync(Path.Combine(system, "expand.exe"), $"-F:* \"{payload}\" \"{expanded}\"");

    return expand != 0
        ? expand
        : await RunAsync(Path.Combine(system, "pnputil.exe"), $"/add-driver \"{expanded}\\*.inf\" /subdirs /install");
}
finally
{
    try
    {
        Directory.Delete(directory, recursive: true);
    }
    catch (IOException)
    {
        // Best-effort cleanup; the payload lives under %TEMP%.
    }
}

static async Task<int> RunAsync(string fileName, string arguments)
{
    Console.WriteLine($"Running {Path.GetFileName(fileName)} {arguments}");
    using var process = Process.Start(new ProcessStartInfo(fileName, arguments))!;
    await process.WaitForExitAsync();

    return process.ExitCode;
}

// Payloads must come from Microsoft's download infrastructure; the digest still decides what runs.
static bool TrustedHost(string host) =>
    host.EndsWith(".windowsupdate.com", StringComparison.OrdinalIgnoreCase)
    || host.EndsWith(".microsoft.com", StringComparison.OrdinalIgnoreCase);

// The catalog reports digests base64-encoded; accept hex too.
static byte[]? Digest(string? value, int size)
{
    if (string.IsNullOrEmpty(value))
    {
        return null;
    }

    try
    {
        var digest = value.Length == size * 2 ? Convert.FromHexString(value) : Convert.FromBase64String(value);
        return digest.Length == size ? digest : null;
    }
    catch (FormatException)
    {
        return null;
    }
}

static bool Take(string arg, string prefix, ref string? value)
{
    if (!arg.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
    {
        return false;
    }

    value = arg[prefix.Length..].Trim('"');
    return true;
}
