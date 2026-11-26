using DuckDB.NET.Data;
using Microsoft.Extensions.Options;
using MsftUpdates.Sync;

namespace MsftUpdates.Catalog;

public sealed class CatalogOptions
{
    /// <summary>Holds one directory of Parquet parts per table, plus removed.parquet.</summary>
    public string DataPath { get; set; } = "/data/catalog";

    /// <summary>Flush staged rows to a new Parquet part once this much XML is buffered.</summary>
    public long PartXmlBytes { get; set; } = 1L << 30;

    /// <summary>Merge a table's parts into one once it has more than this many.</summary>
    public int MaxParts { get; set; } = 64;

    /// <summary>DuckDB memory cap, for syncs and for each query.</summary>
    public string MemoryLimit { get; set; } = "1GB";

    public int Threads { get; set; } = 2;
}

/// <summary>
/// The catalog is append-only Parquet: each sync adds a part per table and rewrites removed.parquet, the
/// revisions the server no longer lists. Views hide removed rows; compaction drops them for good.
/// </summary>
public sealed class CatalogStore(IOptions<CatalogOptions> options)
{
    internal const string XmlTable = "update_xml";

    public static readonly IReadOnlyDictionary<string, string> Tables = new Dictionary<string, string>
    {
        ["updates"] = "update_id UUID, revision INTEGER, update_type VARCHAR, category_type VARCHAR, title VARCHAR, description VARCHAR, creation_date TIMESTAMP, kb_article VARCHAR, security_bulletin VARCHAR, msrc_severity VARCHAR, publication_state VARCHAR, handler VARCHAR, max_download_size BIGINT, legacy_name VARCHAR",
        ["update_xml"] = "update_id UUID, revision INTEGER, xml VARCHAR",
        ["update_cves"] = "update_id UUID, revision INTEGER, cve VARCHAR",
        ["update_categories"] = "update_id UUID, revision INTEGER, category_id UUID",
        ["prerequisites"] = "update_id UUID, revision INTEGER, group_index INTEGER, prerequisite_id UUID, is_category BOOLEAN",
        ["bundled_updates"] = "update_id UUID, revision INTEGER, bundled_id UUID, bundled_revision INTEGER",
        ["superseded_updates"] = "update_id UUID, revision INTEGER, superseded_id UUID",
        ["files"] = "update_id UUID, revision INTEGER, sha1 VARCHAR, sha256 VARCHAR, file_name VARCHAR, size BIGINT, modified TIMESTAMP, url VARCHAR",
        ["driver_metadata"] = "update_id UUID, revision INTEGER, metadata_index INTEGER, hardware_id VARCHAR, driver_version VARCHAR, driver_date DATE, class VARCHAR, company VARCHAR, provider VARCHAR, manufacturer VARCHAR, model VARCHAR, whql_driver_id VARCHAR",
        ["driver_feature_scores"] = "update_id UUID, revision INTEGER, metadata_index INTEGER, operating_system VARCHAR, feature_score VARCHAR",
        ["driver_computer_hardware_ids"] = "update_id UUID, revision INTEGER, metadata_index INTEGER, computer_hardware_id UUID, kind VARCHAR",
    };

    public string DataPath => options.Value.DataPath;

    private string RemovedPath => Path.Combine(DataPath, "removed.parquet");

    public bool Fragmented => Parts("updates").Length > options.Value.MaxParts;

    private string[] Parts(string table) =>
        Directory.Exists(Path.Combine(DataPath, table)) ? Directory.GetFiles(Path.Combine(DataPath, table), "*.parquet") : [];

    public DuckDBConnection OpenDuckDb(string database = ":memory:")
    {
        var connection = new DuckDBConnection($"Data Source={database}");
        connection.Open();
        Execute(connection, $"SET memory_limit = '{options.Value.MemoryLimit}'; SET threads = {options.Value.Threads}; SET preserve_insertion_order = false; SET temp_directory = '{Path.Combine(Path.GetTempPath(), $"duckdb-{Guid.NewGuid():N}")}'");
        return connection;
    }

    /// <summary>
    /// Views over the parts, minus removed revisions, on a connection for clients. Locks the connection's
    /// database so its queries can only read the catalog.
    /// </summary>
    public DuckDBConnection OpenReadOnly()
    {
        var connection = OpenDuckDb();
        CreateViews(connection);
        Execute(connection, $"SET allowed_directories = ['{DataPath.TrimEnd('/')}/']; SET enable_external_access = false; SET lock_configuration = true");
        return connection;
    }

    public void CreateViews(DuckDBConnection connection)
    {
        var removed = File.Exists(RemovedPath)
            ? $"ANTI JOIN read_parquet('{RemovedPath}') r USING (update_id, revision)"
            : string.Empty;
        foreach (var (table, columns) in Tables)
        {
            Execute(connection, Parts(table).Length > 0
                ? $"CREATE VIEW {table} AS SELECT t.* FROM read_parquet('{Path.Combine(DataPath, table)}/*.parquet') t {removed}"
                : $"CREATE TABLE {table} ({columns})");
        }
    }

    public HashSet<RevisionId> ReadRevisions() =>
        ReadRevisions(Parts("updates").Length > 0 ? Path.Combine(DataPath, "updates", "*.parquet") : null);

    private HashSet<RevisionId> ReadRevisions(string? parquet)
    {
        var revisions = new HashSet<RevisionId>();
        if (parquet is null)
        {
            return revisions;
        }
        using var connection = OpenDuckDb();
        using var command = connection.CreateCommand();
        command.CommandText = $"SELECT update_id, revision FROM read_parquet('{parquet}')";
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            revisions.Add(new RevisionId(reader.GetGuid(0), reader.GetInt32(1)));
        }
        return revisions;
    }

    /// <summary>Replaces removed.parquet; returns the fraction of stored revisions it hides.</summary>
    public double WriteRemoved(IReadOnlyCollection<RevisionId> removed, int stored)
    {
        Directory.CreateDirectory(DataPath);
        using var connection = OpenDuckDb();
        Execute(connection, "CREATE TABLE removed (update_id UUID, revision INTEGER)");
        using (var appender = connection.CreateAppender("removed"))
        {
            foreach (var id in removed)
            {
                appender.CreateRow().AppendValue(id.UpdateId).AppendValue(id.Revision).EndRow();
            }
        }
        var temporary = RemovedPath + ".tmp";
        Execute(connection, $"COPY removed TO '{temporary}' (FORMAT parquet, COMPRESSION zstd)");
        File.Move(temporary, RemovedPath, overwrite: true);
        return stored == 0 ? 0 : (double)removed.Count / stored;
    }

    /// <summary>Rewrites each table into one part without removed rows, swaps it in, and drops removed.parquet.</summary>
    public void Compact()
    {
        using var connection = OpenDuckDb();
        CreateViews(connection);
        var stamp = PartName();
        // updates goes last: a crash before it leaves the removed rows listed, so the next sync hides them again
        foreach (var table in Tables.Keys.OrderBy(t => t == "updates"))
        {
            var directory = Path.Combine(DataPath, table);
            var old = Parts(table);
            Directory.CreateDirectory(directory);
            var temporary = Path.Combine(directory, stamp + ".tmp");
            if (table == XmlTable)
            {
                using var writer = new XmlPartWriter(temporary);
                writer.CopyFrom(old, ReadRevisions(File.Exists(RemovedPath) ? RemovedPath : null));
                writer.Close();
            }
            else
            {
                Execute(connection, $"COPY (SELECT * FROM {table}) TO '{temporary}' ({ParquetOptions})");
            }
            File.Move(temporary, Path.Combine(directory, stamp + ".parquet"));
            foreach (var file in old)
            {
                File.Delete(file);
            }
        }
        File.Delete(RemovedPath);
    }

    /// <summary>A writer staging into a database file, so a part's rows can spill to disk while it fills.</summary>
    public CatalogWriter CreateWriter()
    {
        var staging = Path.Combine(Path.GetTempPath(), $"msft-updates-{Guid.NewGuid():N}.duckdb");
        return new(this, OpenDuckDb(staging), staging, options.Value.PartXmlBytes);
    }

    /// <summary>Part names sort in write order, so the newest part of an update's revision is the last.</summary>
    internal static string PartName() => DateTime.UtcNow.ToString("yyyyMMddHHmmssfff", System.Globalization.CultureInfo.InvariantCulture);

    internal const string ParquetOptions = "FORMAT parquet, COMPRESSION zstd, COMPRESSION_LEVEL 9, ROW_GROUP_SIZE 1000000";

    internal static void Execute(DuckDBConnection connection, string sql)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }
}
