# Contributing

```sh
npm install
npm test          # unit tests (node:test)
npm run typecheck
npm run build     # dist/node, dist/web, dist/webview
npm run package   # .vsix
```

Press F5 in VS Code with this folder open to run it in an Extension Development Host.

## Test an unpublished build on vscode.dev

vscode.dev's Content Security Policy only lets **Developer: Install Extension from Location…** fetch from `localhost` (and Microsoft's Marketplace hosts).

1. Build and serve it: `npm run build && PUBLIC_DIR=. bun server/serve.mjs 8787`.
2. Open https://vscode.dev in Chrome or Edge, run **Developer: Install Extension from Location…**, and enter `http://localhost:8787`.

The container image (`server/serve.mjs` behind `https://vscode-kaitai.${PUBLIC_DOMAIN}`) serves the same files with CORS for code-server and other self-hosted workbenches whose CSP allows it.

## Notes

- The parser engine started from the Kaitai support in pl4nty/vscode-hexeditor's structure view. The runtime (`kaitai-struct`) is Apache-2.0.
- README screenshots are in `media/screenshots` and are not packaged in the .vsix. vsce rewrites their relative links with `--baseImagesUrl`.
- A release is a bump of `version` in `package.json`.
