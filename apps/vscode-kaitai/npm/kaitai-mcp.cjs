#!/usr/bin/env node
// `kaitai-mcp` with no arguments runs the MCP server, so MCP configs can use `npx -y kaitai-mcp`. A file of its own
// rather than a second name for dist/kaitai.cjs, because npm's Windows shims hide the name a script was run by.
if (process.argv.length < 3) process.argv.push('mcp');
require('./dist/kaitai.cjs');
