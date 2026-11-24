// Entry point of the `kaitai` executable (bundled to npm/dist/kaitai.cjs). `kaitai-mcp` is npm/kaitai-mcp.cjs.
import { main } from './cli.ts';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`kaitai: ${e?.stack ?? e}\n`);
    process.exitCode = 1;
  },
);
