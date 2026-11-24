// Registers the bundled `kaitai` MCP server (npm/dist/kaitai.cjs, the same build as the kaitai-mcp npm package)
// with VS Code's agent mode, so Copilot and other agents in VS Code get the parse/at/validate/suggest tools.
// Desktop and remote hosts only: the server needs Node. The API is VS Code 1.101+, so it is feature-detected.
import * as vscode from 'vscode';
import { configuredSource } from './formats.ts';

/** The parts of the VS Code 1.101 MCP API used here (@types/vscode is pinned to the 1.90 baseline). */
interface McpApi {
  lm: {
    registerMcpServerDefinitionProvider?(
      id: string,
      provider: { onDidChangeMcpServerDefinitions?: vscode.Event<void>; provideMcpServerDefinitions(): unknown[] },
    ): vscode.Disposable;
  };
  McpStdioServerDefinition?: new (
    label: string,
    command: string,
    args?: string[],
    env?: Record<string, string>,
    version?: string,
  ) => { cwd?: vscode.Uri };
}

export function registerMcpServer(context: vscode.ExtensionContext): vscode.Disposable {
  const api = vscode as unknown as McpApi;
  const Definition = api.McpStdioServerDefinition;
  const register = api.lm?.registerMcpServerDefinitionProvider;
  // The web extension host has no `process` (and cannot spawn one).
  if (!Definition || !register || typeof process !== 'object' || !process.versions?.node) {
    return new vscode.Disposable(() => {});
  }
  const script = vscode.Uri.joinPath(context.extensionUri, 'npm', 'dist', 'kaitai.cjs').fsPath;
  const version = String(context.extension.packageJSON.version);
  const changed = new vscode.EventEmitter<void>();
  return vscode.Disposable.from(
    changed,
    // The gallery settings are passed to the server, so it restarts with them.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('kaitai.formatsRepository') || e.affectsConfiguration('kaitai.formatsRef')) {
        changed.fire();
      }
    }),
    register.call(api.lm, 'kaitai', {
      onDidChangeMcpServerDefinitions: changed.event,
      provideMcpServerDefinitions() {
        const { repo, ref } = configuredSource();
        // The extension host's executable runs as plain Node with ELECTRON_RUN_AS_NODE; on a remote host it is Node.
        const server = new Definition(
          'Kaitai Struct',
          process.execPath,
          [script, 'mcp', `--repo=${repo}`, `--ref=${ref}`],
          { ELECTRON_RUN_AS_NODE: '1' },
          version,
        );
        // Relative paths resolve from the first workspace folder, unless it is virtual (no folder to start in).
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (folder?.scheme === 'file' || folder?.scheme === 'vscode-remote') server.cwd = folder;
        return [server];
      },
    }),
  );
}
