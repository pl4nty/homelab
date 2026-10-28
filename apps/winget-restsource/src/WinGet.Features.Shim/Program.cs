// The installer WinGet downloads from the REST source for every feature package. It translates the
// manifest's InstallerSwitches into a DISM invocation, and maintains an Apps & Features (ARP) entry so
// `winget list` and `winget uninstall` see enabled features:
//
//   winget-feature-shim.exe /action:enable  /kind:Feature    /name:TelnetClient [/version:V] [/display:"Telnet Client"]
//   winget-feature-shim.exe /action:disable /kind:Capability /name:OpenSSH.Client~~~~0.0.1.0
//
// Exit code is DISM's (0, or 3010 when a reboot is pending), 87 (ERROR_INVALID_PARAMETER) for bad arguments.

using System.Diagnostics;
using System.Text.RegularExpressions;
using Microsoft.Win32;

const int InvalidParameter = 87;
const string UninstallKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";

string? action = null, kind = null, name = null, display = null, version = null;
foreach (var arg in args)
{
    // WinGet appends switches like /quiet; anything unknown is ignored.
    _ = Take(arg, "/action:", ref action) || Take(arg, "/kind:", ref kind) || Take(arg, "/name:", ref name)
        || Take(arg, "/display:", ref display) || Take(arg, "/version:", ref version);
}

var enable = action is "enable";
if (action is not ("enable" or "disable") || kind is not ("Feature" or "Capability") || name is null
    || !Regex.IsMatch(name, "^[A-Za-z0-9._~-]+$"))
{
    Console.Error.WriteLine(
        "usage: winget-feature-shim.exe /action:enable|disable /kind:Feature|Capability /name:<dism-name> " +
        "[/version:<version>] [/display:<display-name>]");
    return InvalidParameter;
}

var dismArguments = (kind, enable) switch
{
    ("Feature", true) => $"/online /enable-feature /featurename:{name} /all /norestart /quiet",
    ("Feature", false) => $"/online /disable-feature /featurename:{name} /norestart /quiet",
    ("Capability", true) => $"/online /add-capability /capabilityname:{name} /norestart /quiet",
    _ => $"/online /remove-capability /capabilityname:{name} /norestart /quiet",
};

using var dism = Process.Start(new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "dism.exe"), dismArguments))!;
await dism.WaitForExitAsync();

// 3010 is ERROR_SUCCESS_REBOOT_REQUIRED; the change itself has been made.
if (dism.ExitCode is not (0 or 3010))
{
    Console.Error.WriteLine($"dism {dismArguments} failed with 0x{dism.ExitCode:x8}");
    return dism.ExitCode;
}

// Matches WindowsFeature.ProductCode on the server, which the manifest declares as the installer's
// ProductCode - that is how WinGet correlates the ARP entry with the package.
var bareName = name.Split("~~~~")[0];
var productCode = $"WinGetFeature.{kind}.{bareName}";

if (enable)
{
    // WinGet deletes its downloaded copy after installing, so keep one for the uninstall string.
    var shimCopy = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "winget-features", "winget-feature-shim.exe");
    if (Environment.ProcessPath is { } processPath &&
        !string.Equals(processPath, shimCopy, StringComparison.OrdinalIgnoreCase))
    {
        Directory.CreateDirectory(Path.GetDirectoryName(shimCopy)!);
        File.Copy(processPath, shimCopy, overwrite: true);
    }

    using var key = Registry.LocalMachine.CreateSubKey($@"{UninstallKey}\{productCode}");
    key.SetValue("DisplayName", display ?? bareName);
    key.SetValue("DisplayVersion", version ?? "Unknown");
    key.SetValue("Publisher", "Microsoft");
    key.SetValue("QuietUninstallString", $"\"{shimCopy}\" /action:disable /kind:{kind} /name:{name}");
    key.SetValue("UninstallString", $"\"{shimCopy}\" /action:disable /kind:{kind} /name:{name}");
    key.SetValue("NoModify", 1, RegistryValueKind.DWord);
    key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
}
else
{
    Registry.LocalMachine.DeleteSubKeyTree($@"{UninstallKey}\{productCode}", throwOnMissingSubKey: false);
}

return dism.ExitCode;

static bool Take(string arg, string prefix, ref string? value)
{
    if (!arg.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
    {
        return false;
    }

    value = arg[prefix.Length..].Trim('"');
    return true;
}
