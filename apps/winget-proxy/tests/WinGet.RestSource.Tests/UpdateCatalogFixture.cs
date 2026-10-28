using System.Net;
using System.Text.RegularExpressions;
using System.Web;

namespace WinGet.RestSource.Tests;

public sealed class FakeUpdateCatalogHandler : HttpMessageHandler
{
    public List<Uri> Requests { get; } = [];

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var uri = request.RequestUri!;
        Requests.Add(uri);

        string content;
        if (uri.AbsolutePath.EndsWith("DownloadDialog.aspx"))
        {
            var form = await request.Content!.ReadAsStringAsync(cancellationToken);
            var updateId = Regex.Match(WebUtility.UrlDecode(form), "\"updateID\":\"(?<id>[0-9a-f-]{36})\"").Groups["id"].Value;
            content = UpdateCatalogFixture.DownloadResponse(updateId);
        }
        else if (uri.AbsolutePath.EndsWith("ScopedViewInline.aspx"))
        {
            content = UpdateCatalogFixture.DetailsResponse(HttpUtility.ParseQueryString(uri.Query)["updateid"] ?? string.Empty);
        }
        else
        {
            content = UpdateCatalogFixture.SearchResponse(HttpUtility.ParseQueryString(uri.Query)["q"] ?? string.Empty);
        }

        return new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(content, System.Text.Encoding.UTF8, "text/html"),
        };
    }
}

/// <summary>Canned pages trimmed from real Update Catalog responses.</summary>
public static class UpdateCatalogFixture
{
    public const string MsuUpdateId = "8a4e02a5-476a-4b5e-93cf-01b2a2fcdac0";
    public const string DriverUpdateId = "d1f7a291-6b1c-4d3a-9c3e-2b7f0a1e5b44";
    public const string ExeUpdateId = "3c7e2f60-9a4b-4f2f-8f31-0d2e6c5a1b77";

    // KB5078885 as the catalog lists it: one row per release and architecture, SHA-1 digests only. 21H2 and
    // 22H2 share the x64 file; the x86 rows are given different files here to cover the conflict case.
    public const string Kb = "KB5078885";
    public const string Kb22H2X64 = "a368a53d-af28-419a-ad82-bb5fa8017069";
    public const string Kb21H2X64 = "cd19dd62-f644-4583-a844-33ceae275c18";
    public const string Kb22H2Arm64 = "bf344f5e-fad6-4dae-ab43-44f55cd0c0ac";
    public const string Kb22H2X86 = "fdfd4f1f-5218-4511-a471-59f8a1b39691";
    public const string Kb21H2X86 = "b16f57a1-c2f0-4eba-ba46-bbe22d1bbf33";
    public const string KbDynamicX64 = "e3c9e6f6-9312-4bed-ad92-2bcd45e8924b";

    public const string KbX64Sha1 = "gBNIO1Z/FuBXkxwwclxshyMAejE=";
    public const string KbX64Url =
        "https://catalog.s.download.windowsupdate.com/d/msdownload/update/software/secu/2026/03/" +
        "windows10.0-kb5078885-x64_8013483b567f16e057931c30725c6c8723007a31.msu";
    public const string KbArm64Url =
        "https://catalog.s.download.windowsupdate.com/d/msdownload/update/software/secu/2026/03/" +
        "windows10.0-kb5078885-arm64_af3aa9e0959d6c61c665906dd9f96ba8a5ad1cb6.msu";

    private static readonly string[] KbRows =
    [
        Row(Kb22H2X86, "2026-03 Cumulative Update for Windows 10 Version 22H2 for x86-based Systems (KB5078885)", "Windows 10, version 1903 and later", "Security Updates", "3/10/2026", "n/a"),
        Row(Kb21H2X86, "2026-03 Cumulative Update for Windows 10 Version 21H2 for x86-based Systems (KB5078885)", "Windows 10 LTSB", "Security Updates", "3/10/2026", "n/a"),
        Row(KbDynamicX64, "2026-03 Dynamic Cumulative Update for Windows 10 Version 21H2 for x64-based Systems (KB5078885)", "Windows 10 and later GDR-DU", "Security Updates", "3/10/2026", "n/a"),
        Row(Kb22H2X64, "2026-03 Cumulative Update for Windows 10 Version 22H2 for x64-based Systems (KB5078885)", "Windows 10, version 1903 and later", "Security Updates", "3/10/2026", "n/a"),
        Row(Kb22H2Arm64, "2026-03 Cumulative Update for Windows 10 Version 22H2 for ARM64-based Systems (KB5078885)", "Windows 10, version 1903 and later", "Security Updates", "3/10/2026", "n/a"),
        Row(Kb21H2X64, "2026-03 Cumulative Update for Windows 10 Version 21H2 for x64-based Systems (KB5078885)", "Windows 10 LTSB", "Security Updates", "3/10/2026", "n/a"),
    ];

    public const string MsuTitle = "2026-08 Cumulative Update for Windows 11 Version 24H2 for x64-based Systems (KB5063878)";
    public const string DriverTitle = "Surface - Firmware - 1.2.3.4";

    public const string MsuFileSha256 = "mWy60gScxyiCBnckoZkqQr4rAV1ww9sFOYsuaCuBooM=";
    public const string MsuFileUrl =
        "https://catalog.s.download.windowsupdate.com/c/msdownload/update/software/secu/2026/08/" +
        "windows11.0-kb5063878-x64_bd34458fa840a0f0ea95f42346110eaf2e97e1a3.msu";

    public const string DriverFileSha256 = "vGdY5LPtVKV0bd1G3PxSMFcRw+9DUyxJP9pdW9koh3c=";
    public const string DriverFileUrl =
        "https://catalog.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/2f1c9d0e/public/" +
        "surfacefirmware_amd64_5f1c22a9b7d54f0d9f2b7c3f0a1e5b44d1f7a291.cab";

    /// <summary>The catalog resolves an update GUID query to that update's single row.</summary>
    public static string SearchResponse(string query) => query.ToLowerInvariant() switch
    {
        MsuUpdateId => Page(Row(MsuUpdateId, MsuTitle, "Windows 11", "Security Updates", "8/12/2026", "n/a")),
        DriverUpdateId => Page(Row(DriverUpdateId, DriverTitle, "Windows 11", "Drivers", "7/1/2026", "1.2.3.4")),
        ExeUpdateId => Page(Row(ExeUpdateId, "Update for Microsoft Defender (KB4052623)", "Windows 11", "Definition Updates", "8/1/2026", "n/a")),
        "kb5078885" => Page(KbRows),
        var text when KbRows.FirstOrDefault(row => row.Contains($"<tr id=\"{text}_R0\">")) is { } row => Page(row),
        var text when text.Contains('-') && Guid.TryParse(text, out _) => NoResults,
        _ => Page(
            Row(MsuUpdateId, MsuTitle, "Windows 11", "Security Updates", "8/12/2026", "n/a"),
            Row(DriverUpdateId, DriverTitle, "Windows 11", "Drivers", "7/1/2026", "1.2.3.4"),
            Row(ExeUpdateId, "Update for Microsoft Defender (KB4052623)", "Windows 11", "Definition Updates", "8/1/2026", "n/a")),
    };

    public static string DownloadResponse(string updateId) => updateId switch
    {
        MsuUpdateId => Download(
            $"downloadInformation[0].files[0].url = '{MsuFileUrl}';\r\n" +
            $"downloadInformation[0].files[0].sha256 = '{MsuFileSha256}';\r\n" +
            $"downloadInformation[0].files[0].fileName = 'windows11.0-kb5063878-x64_bd34458fa840a0f0ea95f42346110eaf2e97e1a3.msu';\r\n"),
        DriverUpdateId => Download(
            $"downloadInformation[0].files[0].url = '{DriverFileUrl}';\r\n" +
            $"downloadInformation[0].files[0].sha256 = '{DriverFileSha256}';\r\n" +
            $"downloadInformation[0].files[0].fileName = 'surfacefirmware_amd64_5f1c22a9b7d54f0d9f2b7c3f0a1e5b44d1f7a291.cab';\r\n"),
        // A self-extracting installer: nothing the shim can install silently and verifiably.
        ExeUpdateId => Download(
            "downloadInformation[0].files[0].url = 'https://catalog.s.download.windowsupdate.com/d/msdownload/update/software/defu/2026/08/mpam-fe_x64.exe';\r\n" +
            "downloadInformation[0].files[0].sha256 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';\r\n" +
            "downloadInformation[0].files[0].fileName = 'mpam-fe_x64.exe';\r\n"),
        Kb22H2X64 or Kb21H2X64 => KbDownload(KbX64Url, KbX64Sha1),
        Kb22H2Arm64 => KbDownload(KbArm64Url, "rzqp4JWdbGzGZZBp3floqKWtHLY="),
        Kb22H2X86 => KbDownload(KbArm64Url.Replace("arm64_af3a", "x86_0001"), "AAECAwQFBgcICQoLDA0ODxAREhM="),
        Kb21H2X86 => KbDownload(KbArm64Url.Replace("arm64_af3a", "x86_0002"), "FBUWFxgZGhscHR4fICEiIyQlJic="),
        KbDynamicX64 => KbDownload(KbX64Url.Replace("8013483b", "faf33bb1"), "SvR8eMiCz1zZqhkhXyMZfKdguVZ="),
        _ => Download(string.Empty),
    };

    // The real dialog for these updates: an empty sha256 and the SHA-1 as `digest`.
    private static string KbDownload(string url, string sha1) => Download(
        $"downloadInformation[0].files[0].url = '{url}';\r\n" +
        $"downloadInformation[0].files[0].digest = '{sha1}';\r\n" +
        "downloadInformation[0].files[0].sha256 = '';\r\n" +
        $"downloadInformation[0].files[0].fileName = '{url.Split('/')[^1]}';\r\n");

    public static string DetailsResponse(string updateId) => $$"""
        <div id="detailsView">
          <h1 id="ScopedViewHandler_titleText">title</h1>
          <span id="ScopedViewHandler_desc">{{(updateId == MsuUpdateId
              ? "This security update includes quality improvements."
              : "Driver update.")}}</span>
          <span id="ScopedViewHandler_date">8/12/2026</span>
        </div>
        """;

    private static string Page(params string[] rows) => $$"""
        <html><body><form id="aspnetForm">
        <table id="ctl00_catalogBody_updateMatches" class="resultsBackGround">
          <tr id="headerRow"><td>Title</td></tr>
          {{string.Join('\n', rows)}}
        </table>
        </form></body></html>
        """;

    // The real row layout: C1 title link, C2 products, C3 classification, C4 last updated, C5 version.
    private static string Row(string id, string title, string products, string classification, string date, string version) => $"""
        <tr id="{id}_R0">
          <td class="resultsbottomBorder resultsIconWidth " id="{id}_C0_R0"></td>
          <td class="resultsbottomBorder resultspadding" id="{id}_C1_R0">
            <a id='{id}_link' href="javascript:void(0);" onclick='goToDetails("{id}");'>
              {title}
            </a>
          </td>
          <td class="resultsbottomBorder resultspadding" id="{id}_C2_R0">{products}</td>
          <td class="resultsbottomBorder resultspadding" id="{id}_C3_R0">{classification}</td>
          <td class="resultsbottomBorder resultspadding " id="{id}_C4_R0">{date}</td>
          <td class="resultsbottomBorder resultspadding" id="{id}_C5_R0">{version}</td>
          <td class="resultsbottomBorder resultsSizeWidth" id="{id}_C6_R0"><span id="{id}_size">187.0 MB</span></td>
          <td class="resultsbottomBorder resultsButtonWidth" id="{id}_C7_R0"><input id="{id}" type="button" value='Download' /></td>
        </tr>
        """;

    private const string NoResults = """
        <html><body><form id="aspnetForm">
        <div id="ctl00_catalogBody_noResults" class="noResults">We did not find any results.</div>
        </form></body></html>
        """;

    private static string Download(string files) => $$"""
        <html><body><script>
        var downloadInformation = new Array();
        downloadInformation[0] = new Object();
        downloadInformation[0].files = new Array();
        {{files}}
        </script></body></html>
        """;
}
