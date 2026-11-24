// Entry point of the `kaitai` / `kaitai-mcp` executables (bundled to npm/dist/kaitai.cjs).
import { basename } from 'node:path';
import { main } from './cli.ts';

// `kaitai-mcp` with no arguments runs the MCP server, so MCP configs can use `npx -y kaitai-mcp`.
const argv = process.argv.slice(2);
const asServer = /^kaitai-mcp(\.c?js)?$/.test(basename(process.argv[1] ?? '')) && !argv.length;
main(asServer ? ['mcp'] : argv).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`kaitai: ${e?.stack ?? e}\n`);
    process.exitCode = 1;
  },
);
