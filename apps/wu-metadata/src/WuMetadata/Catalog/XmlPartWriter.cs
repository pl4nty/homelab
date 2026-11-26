using ParquetSharp;
using WuMetadata.Sync;

namespace WuMetadata.Catalog;

/// <summary>
/// Writes an update_xml part with row groups capped by size. DuckDB's writer can't do this: its smallest
/// row group is 2048 rows, which is gigabytes where the 70 MB updates cluster.
/// </summary>
internal sealed class XmlPartWriter : IDisposable
{
    private const long RowGroupBytes = 64L << 20;

    private static readonly Column[] Columns =
    [
        new Column<Guid>("update_id"),
        new Column<int>("revision"),
        new Column<string>("xml", LogicalType.String()),
    ];

    private readonly ParquetFileWriter _writer;
    private readonly List<Guid> _ids = [];
    private readonly List<int> _revisions = [];
    private readonly List<string> _xml = [];
    private long _buffered;

    public XmlPartWriter(string path)
    {
        using var properties = new WriterPropertiesBuilder()
            .Compression(Compression.Zstd)
            .CompressionLevel(9)
            .DisableDictionary("xml")
            .Build();
        _writer = new ParquetFileWriter(path, Columns, properties);
    }

    public void Add(Guid id, int revision, string xml)
    {
        _ids.Add(id);
        _revisions.Add(revision);
        _xml.Add(xml);
        _buffered += xml.Length;
        if (_buffered >= RowGroupBytes)
        {
            WriteRowGroup();
        }
    }

    public void Close()
    {
        WriteRowGroup();
        _writer.Close();
    }

    /// <summary>Copies <paramref name="parts"/> into this part, leaving out <paramref name="removed"/>.</summary>
    public void CopyFrom(IEnumerable<string> parts, IReadOnlySet<RevisionId> removed)
    {
        foreach (var part in parts)
        {
            using var reader = new ParquetFileReader(part);
            for (var group = 0; group < reader.FileMetaData.NumRowGroups; group++)
            {
                using var rowGroup = reader.RowGroup(group);
                var rows = checked((int)rowGroup.MetaData.NumRows);
                var ids = Read<Guid>(rowGroup, 0, rows);
                var revisions = Read<int>(rowGroup, 1, rows);
                var xml = Read<string>(rowGroup, 2, rows);
                for (var i = 0; i < rows; i++)
                {
                    if (!removed.Contains(new RevisionId(ids[i], revisions[i])))
                    {
                        Add(ids[i], revisions[i], xml[i]);
                    }
                }
            }
        }
    }

    private static T[] Read<T>(RowGroupReader rowGroup, int column, int rows)
    {
        using var columnReader = rowGroup.Column(column);
        using var reader = columnReader.LogicalReader<T>();
        return reader.ReadAll(rows);
    }

    private void WriteRowGroup()
    {
        if (_ids.Count == 0)
        {
            return;
        }
        using (var rowGroup = _writer.AppendRowGroup())
        {
            Write(rowGroup, _ids);
            Write(rowGroup, _revisions);
            Write(rowGroup, _xml);
        }
        _ids.Clear();
        _revisions.Clear();
        _xml.Clear();
        _buffered = 0;
    }

    private static void Write<T>(RowGroupWriter rowGroup, List<T> values)
    {
        using var columnWriter = rowGroup.NextColumn();
        using var writer = columnWriter.LogicalWriter<T>();
        writer.WriteBatch(values.ToArray());
    }

    public void Dispose() => _writer.Dispose();
}
