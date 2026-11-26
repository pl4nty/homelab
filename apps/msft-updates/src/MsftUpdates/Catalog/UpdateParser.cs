using System.Globalization;
using System.Xml;

namespace MsftUpdates.Catalog;

public sealed class ParsedUpdate
{
    public Guid UpdateId { get; set; }
    public int Revision { get; set; }
    public string? UpdateType { get; set; }
    public string? CategoryType { get; set; }
    public string? Title { get; set; }
    public string? Description { get; set; }
    public DateTime? CreationDate { get; set; }
    public string? KbArticle { get; set; }
    public string? SecurityBulletin { get; set; }
    public string? MsrcSeverity { get; set; }
    public string? PublicationState { get; set; }
    public string? Handler { get; set; }
    public long? MaxDownloadSize { get; set; }
    public string? LegacyName { get; set; }
    public List<string> Cves { get; } = [];
    public List<Guid> Categories { get; } = [];
    public List<(int Group, Guid Id, bool IsCategory)> Prerequisites { get; } = [];
    public List<(Guid Id, int? Revision)> Bundled { get; } = [];
    public List<Guid> Superseded { get; } = [];
    public List<UpdateFile> Files { get; } = [];
    public List<DriverMetadata> Drivers { get; } = [];
    public List<(int MetadataIndex, Guid Id, string Kind)> ComputerHardwareIds { get; } = [];
}

public sealed class UpdateFile
{
    public string? Sha1 { get; set; }
    public string? Sha256 { get; set; }
    public string? FileName { get; set; }
    public long? Size { get; set; }
    public DateTime? Modified { get; set; }
    public string? Url { get; set; }
}

public sealed class DriverMetadata
{
    public int Index { get; init; }
    public string? HardwareId { get; init; }
    public string? DriverVersion { get; init; }
    public DateOnly? DriverDate { get; init; }
    public string? Class { get; init; }
    public string? Company { get; init; }
    public string? Provider { get; init; }
    public string? Manufacturer { get; init; }
    public string? Model { get; init; }
    public string? WhqlDriverId { get; init; }
    public List<(string? OperatingSystem, string? FeatureScore)> FeatureScores { get; } = [];
}

/// <summary>
/// Pulls the queryable fields out of one update's XML in a single forward pass. The full XML stays in
/// <c>update_xml</c> for anything not extracted here.
/// </summary>
public static class UpdateParser
{
    private static readonly XmlReaderSettings Settings = new()
    {
        IgnoreWhitespace = true,
        IgnoreComments = true,
        DtdProcessing = DtdProcessing.Prohibit,
    };

    public static ParsedUpdate Parse(string xml, IReadOnlyDictionary<string, string> fileUrls)
    {
        var update = new ParsedUpdate();
        using var reader = XmlReader.Create(new StringReader(xml), Settings);
        var path = new List<string>();
        var group = -1;
        var groupIsCategory = false;
        string? titleLanguage = null, language = null;
        UpdateFile? file = null;
        DriverMetadata? driver = null;
        var driverIndex = 0;

        // ReadElementContentAsString leaves the reader on the next node, so those cases skip the Read below
        reader.Read();
        while (!reader.EOF)
        {
            if (reader.NodeType == XmlNodeType.EndElement)
            {
                switch (path[^1])
                {
                    case "File":
                        file = null;
                        break;
                    case "WindowsDriverMetaData":
                        driver = null;
                        break;
                    case "AtLeastOne":
                        groupIsCategory = false;
                        break;
                    case "LocalizedProperties":
                        language = null;
                        break;
                }
                path.RemoveAt(path.Count - 1);
            }
            if (reader.NodeType != XmlNodeType.Element)
            {
                reader.Read();
                continue;
            }

            var name = reader.LocalName;
            var parent = path.Count > 0 ? path[^1] : null;
            switch (name)
            {
                case "UpdateIdentity":
                    var id = Guid.Parse(reader.GetAttribute("UpdateID")!);
                    var revision = reader.GetAttribute("RevisionNumber") is { } r ? int.Parse(r, CultureInfo.InvariantCulture) : (int?)null;
                    if (update.UpdateId == default && parent == "Update")
                    {
                        update.UpdateId = id;
                        update.Revision = revision ?? 0;
                    }
                    else if (parent == "Prerequisites")
                    {
                        update.Prerequisites.Add((++group, id, false));
                    }
                    else if (parent == "AtLeastOne" && path.Contains("Prerequisites"))
                    {
                        update.Prerequisites.Add((group, id, groupIsCategory));
                        if (groupIsCategory)
                        {
                            update.Categories.Add(id);
                        }
                    }
                    else if (parent == "BundledUpdates")
                    {
                        update.Bundled.Add((id, revision));
                    }
                    else if (parent == "SupersededUpdates")
                    {
                        update.Superseded.Add(id);
                    }
                    break;
                case "AtLeastOne" when parent == "Prerequisites":
                    group++;
                    groupIsCategory = reader.GetAttribute("IsCategory") == "true";
                    break;
                case "Properties" when parent == "Update":
                    update.UpdateType = reader.GetAttribute("UpdateType");
                    update.CreationDate = ParseDate(reader.GetAttribute("CreationDate"));
                    update.PublicationState = reader.GetAttribute("PublicationState");
                    update.MsrcSeverity = reader.GetAttribute("MsrcSeverity");
                    update.Handler = reader.GetAttribute("Handler");
                    update.LegacyName = reader.GetAttribute("LegacyName");
                    update.MaxDownloadSize = ParseLong(reader.GetAttribute("MaxDownloadSize"));
                    break;
                case "KBArticleID" when parent == "Properties":
                    update.KbArticle = reader.ReadElementContentAsString();
                    continue;
                case "CveID" when parent == "Properties":
                    update.Cves.Add(reader.ReadElementContentAsString().Trim());
                    continue;
                case "SecurityBulletinID" when parent == "Properties":
                    update.SecurityBulletin = reader.ReadElementContentAsString();
                    continue;
                case "Language" when parent == "LocalizedProperties":
                    language = reader.ReadElementContentAsString();
                    continue;
                case "Title" when parent == "LocalizedProperties":
                    var title = reader.ReadElementContentAsString();
                    // English when there is one, otherwise the first language listed
                    if (titleLanguage is null || (titleLanguage != "en" && language == "en"))
                    {
                        update.Title = title;
                        update.Description = null;
                        titleLanguage = language ?? string.Empty;
                    }
                    continue;
                case "Description" when parent == "LocalizedProperties":
                    var description = reader.ReadElementContentAsString();
                    if (titleLanguage == (language ?? string.Empty))
                    {
                        update.Description = description;
                    }
                    continue;
                case "CategoryInformation":
                    update.CategoryType = reader.GetAttribute("CategoryType");
                    break;
                case "File" when parent == "Files":
                    file = new UpdateFile
                    {
                        Sha1 = Hex(reader.GetAttribute("Digest")),
                        FileName = reader.GetAttribute("FileName"),
                        Size = ParseLong(reader.GetAttribute("Size")),
                        Modified = ParseDate(reader.GetAttribute("Modified")),
                        Url = reader.GetAttribute("Digest") is { } digest ? fileUrls.GetValueOrDefault(digest) : null,
                    };
                    update.Files.Add(file);
                    if (reader.IsEmptyElement)
                    {
                        file = null;
                    }
                    break;
                case "AdditionalDigest" when file is not null:
                    var algorithm = reader.GetAttribute("Algorithm");
                    var value = reader.ReadElementContentAsString();
                    if (algorithm == "SHA256")
                    {
                        file.Sha256 = Hex(value);
                    }
                    continue;
                case "WindowsDriverMetaData":
                    driver = new DriverMetadata
                    {
                        Index = driverIndex++,
                        HardwareId = reader.GetAttribute("HardwareID")?.ToLowerInvariant(),
                        DriverVersion = reader.GetAttribute("DriverVerVersion"),
                        DriverDate = DateOnly.TryParseExact(reader.GetAttribute("DriverVerDate"), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date) ? date : null,
                        Class = reader.GetAttribute("Class"),
                        Company = reader.GetAttribute("Company"),
                        Provider = reader.GetAttribute("Provider"),
                        Manufacturer = reader.GetAttribute("Manufacturer"),
                        Model = reader.GetAttribute("Model"),
                        WhqlDriverId = reader.GetAttribute("WhqlDriverID"),
                    };
                    update.Drivers.Add(driver);
                    if (reader.IsEmptyElement)
                    {
                        driver = null;
                    }
                    break;
                case "FeatureScore" when driver is not null:
                    driver.FeatureScores.Add((reader.GetAttribute("OperatingSystem"), reader.GetAttribute("FeatureScore")));
                    break;
                case "TargetComputerHardwareId" or "DistributionComputerHardwareId":
                    var kind = name == "TargetComputerHardwareId" ? "target" : "distribution";
                    var index = driver?.Index ?? -1;
                    if (Guid.TryParse(reader.ReadElementContentAsString(), out var chid))
                    {
                        update.ComputerHardwareIds.Add((index, chid, kind));
                    }
                    continue;
            }
            if (!reader.IsEmptyElement)
            {
                path.Add(name);
            }
            reader.Read();
        }
        return update;
    }

    private static DateTime? ParseDate(string? value) =>
        DateTime.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var date) ? date : null;

    private static long? ParseLong(string? value) =>
        long.TryParse(value, CultureInfo.InvariantCulture, out var number) ? number : null;

    private static string? Hex(string? base64)
    {
        if (base64 is null)
        {
            return null;
        }
        Span<byte> bytes = stackalloc byte[64];
        return Convert.TryFromBase64String(base64, bytes, out var written) ? Convert.ToHexStringLower(bytes[..written]) : null;
    }
}
