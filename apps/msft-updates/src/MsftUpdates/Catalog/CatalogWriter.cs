using DuckDB.NET.Data;

namespace MsftUpdates.Catalog;

/// <summary>
/// Stages parsed updates and writes them out as one Parquet part per table. XML goes straight to its part
/// file; the other tables stage in DuckDB.
/// </summary>
public sealed class CatalogWriter : IDisposable
{
    private readonly CatalogStore _store;
    private readonly DuckDBConnection _connection;
    private readonly string _staging;
    private readonly long _partXmlBytes;
    private readonly Dictionary<string, DuckDBAppender> _appenders = [];
    private string _part = CatalogStore.PartName();
    private XmlPartWriter? _xml;
    private long _stagedXml;

    public int Written { get; private set; }

    internal CatalogWriter(CatalogStore store, DuckDBConnection connection, string staging, long partXmlBytes)
    {
        _store = store;
        _connection = connection;
        _staging = staging;
        _partXmlBytes = partXmlBytes;
        foreach (var (table, columns) in CatalogStore.Tables.Where(t => t.Key != CatalogStore.XmlTable))
        {
            CatalogStore.Execute(_connection, $"CREATE TABLE {table} ({columns})");
        }
        OpenAppenders();
    }

    public void Add(ParsedUpdate u, string xml)
    {
        var (id, rev) = (u.UpdateId, u.Revision);
        Row("updates").AppendValue(id).AppendValue(rev).AppendValue(u.UpdateType).AppendValue(u.CategoryType).AppendValue(u.Title)
            .AppendValue(u.Description).AppendValue(u.CreationDate).AppendValue(u.KbArticle).AppendValue(u.SecurityBulletin)
            .AppendValue(u.MsrcSeverity).AppendValue(u.PublicationState).AppendValue(u.Handler).AppendValue(u.MaxDownloadSize)
            .AppendValue(u.LegacyName).EndRow();
        _xml ??= new XmlPartWriter(Temporary(CatalogStore.XmlTable));
        _xml.Add(id, rev, xml);
        foreach (var cve in u.Cves)
        {
            Row("update_cves").AppendValue(id).AppendValue(rev).AppendValue(cve).EndRow();
        }
        foreach (var category in u.Categories)
        {
            Row("update_categories").AppendValue(id).AppendValue(rev).AppendValue(category).EndRow();
        }
        foreach (var (group, prerequisite, isCategory) in u.Prerequisites)
        {
            Row("prerequisites").AppendValue(id).AppendValue(rev).AppendValue(group).AppendValue(prerequisite).AppendValue(isCategory).EndRow();
        }
        foreach (var (bundled, bundledRevision) in u.Bundled)
        {
            Row("bundled_updates").AppendValue(id).AppendValue(rev).AppendValue(bundled).AppendValue(bundledRevision).EndRow();
        }
        foreach (var superseded in u.Superseded)
        {
            Row("superseded_updates").AppendValue(id).AppendValue(rev).AppendValue(superseded).EndRow();
        }
        foreach (var f in u.Files)
        {
            Row("files").AppendValue(id).AppendValue(rev).AppendValue(f.Sha1).AppendValue(f.Sha256).AppendValue(f.FileName)
                .AppendValue(f.Size).AppendValue(f.Modified).AppendValue(f.Url).EndRow();
        }
        foreach (var d in u.Drivers)
        {
            Row("driver_metadata").AppendValue(id).AppendValue(rev).AppendValue(d.Index).AppendValue(d.HardwareId).AppendValue(d.DriverVersion)
                .AppendValue(d.DriverDate).AppendValue(d.Class).AppendValue(d.Company).AppendValue(d.Provider).AppendValue(d.Manufacturer)
                .AppendValue(d.Model).AppendValue(d.WhqlDriverId).EndRow();
            foreach (var (os, score) in d.FeatureScores)
            {
                Row("driver_feature_scores").AppendValue(id).AppendValue(rev).AppendValue(d.Index).AppendValue(os).AppendValue(score).EndRow();
            }
        }
        foreach (var (index, chid, kind) in u.ComputerHardwareIds)
        {
            Row("driver_computer_hardware_ids").AppendValue(id).AppendValue(rev).AppendValue(index).AppendValue(chid).AppendValue(kind).EndRow();
        }

        Written++;
        _stagedXml += xml.Length;
        if (_stagedXml >= _partXmlBytes)
        {
            Flush();
        }
    }

    /// <summary>Writes staged rows as new parts. Parts land under a .tmp name and are renamed, so readers never see half a file.</summary>
    public void Flush()
    {
        if (_xml is null)
        {
            return;
        }
        CloseAppenders();
        _xml.Close();
        _xml.Dispose();
        _xml = null;
        foreach (var table in CatalogStore.Tables.Keys.Where(t => t != CatalogStore.XmlTable))
        {
            CatalogStore.Execute(_connection, $"COPY {table} TO '{Temporary(table)}' ({CatalogStore.ParquetOptions})");
            CatalogStore.Execute(_connection, $"TRUNCATE {table}");
        }
        // updates goes last: a revision counts as stored once its updates row is visible
        foreach (var table in CatalogStore.Tables.Keys.OrderBy(t => t == "updates"))
        {
            File.Move(Temporary(table), Path.ChangeExtension(Temporary(table), ".parquet"));
        }
        _part = CatalogStore.PartName();
        _stagedXml = 0;
        OpenAppenders();
    }

    private string Temporary(string table)
    {
        var directory = Path.Combine(_store.DataPath, table);
        Directory.CreateDirectory(directory);
        return Path.Combine(directory, _part + ".tmp");
    }

    private IDuckDBAppenderRow Row(string table) => _appenders[table].CreateRow();

    private void OpenAppenders()
    {
        foreach (var table in CatalogStore.Tables.Keys.Where(t => t != CatalogStore.XmlTable))
        {
            _appenders[table] = _connection.CreateAppender(table);
        }
    }

    private void CloseAppenders()
    {
        foreach (var appender in _appenders.Values)
        {
            appender.Dispose();
        }
        _appenders.Clear();
    }

    public void Dispose()
    {
        CloseAppenders();
        if (_xml is not null)
        {
            _xml.Dispose();
            File.Delete(Temporary(CatalogStore.XmlTable));
        }
        _connection.Dispose();
        File.Delete(_staging);
        File.Delete(_staging + ".wal");
    }
}
