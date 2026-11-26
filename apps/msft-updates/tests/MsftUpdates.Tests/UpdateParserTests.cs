using WuMetadata.Catalog;
using Xunit;

namespace WuMetadata.Tests;

public sealed class UpdateParserTests
{
    [Fact]
    public void Parse_Driver_ExtractsHardwareIdsAndFiles()
    {
        var update = UpdateParser.Parse(FakeUpdateServer.Fixture("driver.xml"), new Dictionary<string, string>
        {
            ["yTjjvqoPHTb2n9HTfk+BmL1XAXQ="] = FakeUpdateServer.DriverUrl,
        });

        Assert.Equal(FakeUpdateServer.Driver.UpdateId, update.UpdateId);
        Assert.Equal(200, update.Revision);
        Assert.Equal("Driver", update.UpdateType);
        Assert.Equal("Intel Corporation driver update for Intel(R) HD Graphics 520", update.Title);
        Assert.Equal(161621487, update.MaxDownloadSize);

        var driver = Assert.Single(update.Drivers);
        Assert.Equal(@"pci\ven_8086&dev_1916&subsys_39f217aa", driver.HardwareId);
        Assert.Equal("21.20.16.4542", driver.DriverVersion);
        Assert.Equal(new DateOnly(2016, 10, 24), driver.DriverDate);
        Assert.Equal("Video", driver.Class);
        Assert.Equal(2, update.ComputerHardwareIds.Count(c => c.Kind == "distribution"));

        var file = Assert.Single(update.Files);
        Assert.Equal("c938e3beaa0f1d36f69fd1d37e4f8198bd570174", file.Sha1);
        Assert.Equal("200042644.cab", file.FileName);
        Assert.Equal(FakeUpdateServer.DriverUrl, file.Url);

        Assert.Contains(update.Prerequisites, p => p.IsCategory && p.Id == FakeUpdateServer.Classification.UpdateId);
        Assert.Contains(FakeUpdateServer.Product.UpdateId, update.Categories);
    }

    [Fact]
    public void Parse_Software_ExtractsKbCveAndSupersedence()
    {
        var update = UpdateParser.Parse(FakeUpdateServer.Fixture("software.xml"), new Dictionary<string, string>());

        Assert.Equal("Software", update.UpdateType);
        Assert.Equal("5023052", update.KbArticle);
        Assert.Equal("Important", update.MsrcSeverity);
        Assert.Equal(["CVE-2024-21397"], update.Cves);
        Assert.NotEmpty(update.Superseded);
        Assert.NotEmpty(update.Bundled);
        Assert.Empty(update.Drivers);
    }

    [Fact]
    public void Parse_Category_ReadsCategoryType()
    {
        var update = UpdateParser.Parse(FakeUpdateServer.Fixture("classification.xml"), new Dictionary<string, string>());

        Assert.Equal("Category", update.UpdateType);
        Assert.Equal("UpdateClassification", update.CategoryType);
        Assert.Equal("Drivers", update.Title);
    }
}
