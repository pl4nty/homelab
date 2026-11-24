// Registers the bundled `kaitai` MCP server (npm/dist/kaitai.cjs, the same build as the kaitai-mcp npm package)
// with VS Code's agent mode, so Copilot and other agents in VS Code get the parse/at/validate/suggest tools.
// Desktop and remote hosts only: the server needs Node. The API is VS Code 1.101+, so it is feature-detected.
import * as vscode from 'vscode';

/** The parts of the VS Code 1.101 MCP API used here (@types/vscode is pinned to the 1.90 baseline). */
interface McpApi {
  lm: {
    registerMcpServerDefinitionProvider?(
      id: string,
      provider: { provideMcpServerDefinitions(): unknown[] },
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
  return register.call(api.lm, 'kaitai', {
    provideMcpServerDefinitions() {
      // The extension host's executable runs as plain Node with ELECTRON_RUN_AS_NODE; on a remote host it is Node.
      const server = new Definition(
        'Kaitai Struct',
        process.execPath,
        [script, 'mcp'],
        { ELECTRON_RUN_AS_NODE: '1' },
        version,
      );
      server.cwd = vscode.workspace.workspaceFolders?.[0]?.uri;
      return [server];
    },
  });
}
