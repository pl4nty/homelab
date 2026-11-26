# msft-updates

A mirror of all Microsoft Update metadata (2.76M updates, 90% drivers) that clients query with SQL. It
syncs from `sws.update.microsoft.com` with the WSUS server-server protocol ([MS-WSUSSS]), the way a
WSUS server syncs from Microsoft Update, and keeps content URLs, not content.

## Quick start

1. Run it with a data volume. The first sync starts at once and takes about 35 minutes, then it syncs
   hourly:

   ```sh
   docker run -p 8080:8080 -v msft-updates:/data ghcr.io/pl4nty/msft-updates
   ```

2. Watch `GET /status` until `Completed` is set.
3. Send SQL as the body of `POST /query`:

   ```sh
   curl --data-binary @- http://localhost:8080/query <<'SQL'
   SELECT d.driver_version, d.driver_date, f.url
   FROM driver_metadata d JOIN files f USING (update_id, revision)
   WHERE d.hardware_id = 'pci\ven_8086&dev_1916&subsys_39f217aa'
   ORDER BY d.driver_date DESC
   SQL
   ```

## Querying

Queries run in DuckDB over the catalog's Parquet files. `POST /query` speaks the protocol of DuckDB's
[httpserver](https://duckdb.org/community_extensions/extensions/httpserver.html) extension: the
response is one JSON object per row, or `{meta, data, rows}` with a `format: JSONCompact` header.
`X-Truncated: true` marks a result cut at the row or size cap.

- `updates`: one row per revision, with title, type, KB, MSRC severity and dates. Categories are
  updates too (`update_type = 'Category'`; `category_type` is Product, ProductFamily, Company or
  UpdateClassification).
- `files`: SHA-1, SHA-256, size and download URL of each file.
- `driver_metadata`: hardware ID (lowercased), version, date, class, provider and model of each driver.
- `driver_computer_hardware_ids`: CHIDs a driver targets or is distributed to, by `metadata_index`.
- `driver_feature_scores`, `update_categories`, `prerequisites`, `bundled_updates`,
  `superseded_updates`, `update_cves`.
- `update_xml`: each revision's full XML, for anything the tables leave out.

Every table is keyed by `(update_id, revision)`. `GET /files` lists the Parquet files and
`GET /files/{path}` serves them, so DuckDB, Spark or pandas can read the catalog directly instead.

## Web UI

The homelab deployment serves [Duck-UI](https://github.com/caioricciuti/duck-ui) in kiosk mode on
the same host, with its external connection pointed at `POST /query`, so it browses the tables and
runs queries under the same limits as any other client. DuckDB's own
[UI extension](https://duckdb.org/docs/stable/core_extensions/ui) doesn't fit: it listens on
localhost only, loads its frontend from `ui.duckdb.org`, and has no read-only mode.

## Storage

The catalog is about 2.1 GB: 0.5 GB of tables and 1.5 GB of XML, from 89 GB of XML as served. It is
Parquet with zstd level 9, one directory of parts per table. Each sync adds parts and rewrites
`removed.parquet`, the revisions Microsoft dropped, which the views hide. The tables are merged
back into one part each once they have 64 parts, or once removed rows pass 5%. DuckDB writes the
tables; ParquetSharp writes the XML, because DuckDB's smallest row group is 2048 rows, which is
gigabytes where the 70 MB updates cluster.

The format was picked from these options, measured on a 5% sample (138k updates, 4.3 GB of XML) and
scaled by 20:

| Option | Tables (MB) | XML (MB) | Full catalog, est. |
| --- | --: | --: | --: |
| **Parquet, zstd 9** (chosen, measured 2.1 GB) | 32.7 | 80.9 | 2.3 GB |
| Parquet, zstd 19 | 35.7 | 68.4 | 2.1 GB, XML 24× slower to write |
| Parquet, zstd 3 | 38.9 | 98.5 | 2.7 GB |
| Parquet, brotli | 34.8 | not run | |
| Parquet, LZ4 | 52.4 | 267.6 | 6.4 GB |
| Parquet, Snappy | 56.2 | 493.2 | 11 GB |
| ORC, zstd | 60.0 | 239.6 | 6.0 GB |
| Lance | 140.1 | 400.9 | 11 GB |
| Vortex | 82.8 | 1160.7 | 25 GB |
| DuckDB database | 286.5 | 99.6 | 7.7 GB |
| DuckDB database, `force_compression = 'zstd'` | 407.4 | 99.6 | 10 GB |
| ClickHouse MergeTree, ZSTD(19) | 87.4 | 142.0 | 4.6 GB |
| ClickHouse MergeTree, ZSTD(3) | 99.9 | 324.9 | 8.5 GB |
| ClickHouse MergeTree, LZ4 | 162.1 | 761.2 | 18 GB |
| PostgreSQL 16, lz4 TOAST | 1660.6 | 707.8 | 47 GB |
| PostgreSQL 16, pglz TOAST | 1660.6 | 839.6 | 50 GB |
| SQLite | 1820.3 | 4709.1 | 131 GB |
| SQLite, XML as zstd 9 blobs with a trained dictionary | 1820.3 | 138.3 | 39 GB |
| SQLite, XML as zstd 3 blobs | 1820.3 | 414.5 | 45 GB |
| RocksDB, zstd 9 with a trained dictionary | | 124.6 | |
| RocksDB, zstd 3 | | 397.9 | |
| LMDB | | 4556.6 | |
| XML as one zstd 19 `--long` stream (not queryable) | | 50.1 | |
| XML as one xz `-9e` stream (not queryable) | | 49.7 | |

At 2 GB the catalog is well under the 10 GB where a custom format would pay off. The stream rows
bound what one could save: a seekable-zstd store of the XML would be about 1 GB, so 0.5 GB less.
Row stores (SQLite, PostgreSQL, LMDB) can't compress across rows, and PostgreSQL only compresses
values over 2 KB ([TOAST](https://www.postgresql.org/docs/current/storage-toast.html)). These were
considered and not measured:

- MongoDB (WiredTiger zstd) and SQL Server (columnstore archive): they need Docker, which wasn't
  available. WiredTiger compresses per block like RocksDB
  ([docs](https://www.mongodb.com/docs/manual/core/wiredtiger/#compression)).
- DuckLake, Iceberg and Delta: these are catalogs over Parquet files, so the bytes are the same as
  plain Parquet ([DuckLake](https://ducklake.select/)).
- sqlite-zstd: row-level dictionary compression in SQLite, which the SQLite dictionary row measures
  ([repo](https://github.com/phiresky/sqlite-zstd)).
- Elasticsearch `best_compression`, Arrow IPC with zstd, and LiteDB.

## Limits

- Only SELECT runs. Queries see the catalog alone: no file, URL or extension access.
- Two queries run at once, each with 1 GB of memory, 2 minutes, and 100,000 rows or 64 MB of
  results.
- Each client (by `CF-Connecting-IP`) gets 60 queries a minute. Parquet parts are cacheable forever, as
  part names are never reused.
- Queries on `update_xml` read 89 GB of XML when they can't filter by `update_id`, which takes about
  30 seconds.
- Compressed updates are extracted with `cabextract`, as .NET has no LZX decoder.
- A sync holds up to about 5 GB while it fetches the whole catalog. Later syncs take about 1.5 minutes.
- Previews (`Sync__Full=false`) fetch 2000 updates instead of the whole catalog.

[MS-WSUSSS]: https://learn.microsoft.com/openspecs/windows_protocols/ms-wsusss/
