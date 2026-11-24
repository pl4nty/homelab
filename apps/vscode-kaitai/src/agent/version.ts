// Package version, set by esbuild from npm/package.json. `dev` when run from source (tests).
declare const __KAITAI_CLI_VERSION__: string | undefined;

export const VERSION: string = typeof __KAITAI_CLI_VERSION__ === 'string' ? __KAITAI_CLI_VERSION__ : 'dev';
