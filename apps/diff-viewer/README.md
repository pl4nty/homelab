# diff-viewer

Compare two texts or a `git diff` patch and share the result as a link. Rendering uses [@pierre/diffs](https://diffs.com).

- Links up to 10,000 characters hold the compressed diff in the URL fragment, so the server never sees it.
- Longer diffs are encrypted in the browser (AES-GCM) and stored on the server for a year. The key stays in the link's fragment.

## Server

`main.go` serves `web/dist` and the storage API:

- `POST /api/diffs` stores an encrypted blob and returns `{id, expires}`.
- `GET /api/diffs/{id}` returns the blob with a `Diff-Expires` header.

| Variable | Default |
| --- | --- |
| `DATA_DIR` | `/data` |
| `WEB_DIR` | `/web` |
| `TTL` | `8760h` |
| `MAX_BYTES` | `16777216` |

An hourly sweep deletes expired diffs. Uploads get `507` when the volume has under 32 MiB free.

## Develop

```sh
cd web && npm ci && npm test && npm run build && cd ..
go test ./... && DATA_DIR=$(mktemp -d) WEB_DIR=web/dist ADDR=:8080 go run .
```
