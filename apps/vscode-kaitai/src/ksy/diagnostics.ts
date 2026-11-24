// Diagnostics for open .ksy documents (YAML syntax + compiler errors), a status bar summary and
// "did you mean" quick fixes for unknown types and enums.
import * as vscode from 'vscode';
import type { Session } from '../session.ts';
import { diagnosticTargetPath, isImportedError, suggestionsFor, unresolvedName } from './language.ts';
import { forgetImports, importedSpecs, parsedOf } from './resolve.ts';
import { rangeForPath } from './yamlAst.ts';

const DEBOUNCE_MS = 400;

interface FixData {
  path: string[];
  what: 'type' | 'enum';
  name: string;
}

export class KsyDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('kaitai');
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly fixes = new WeakMap<vscode.Diagnostic, FixData>();
  private readonly status = vscode.window.createStatusBarItem('kaitai.ksyStatus', vscode.StatusBarAlignment.Left, 50);
  private readonly disposables: vscode.Disposable[] = [this.collection, this.status];
  private readonly session: Session;

  constructor(session: Session) {
    this.session = session;
    this.status.name = 'Kaitai Struct spec status';
    this.status.command = 'workbench.actions.view.problems';
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((d) => this.schedule(d, 0)),
      vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document, DEBOUNCE_MS)),
      vscode.workspace.onDidSaveTextDocument((d) => this.schedule(d, 0)),
      vscode.workspace.onDidCloseTextDocument((d) => {
        clearTimeout(this.timers.get(d.uri.toString()));
        this.timers.delete(d.uri.toString());
        this.collection.delete(d.uri);
        this.updateStatus();
      }),
      // An imported file changed: recheck every open spec.
      session.templates.onDidChangeSpec((uri) => {
        forgetImports();
        for (const d of vscode.workspace.textDocuments) {
          if (d.languageId !== 'ksy' || d.uri.toString() === uri.toString()) continue;
          this.schedule(d, 0);
        }
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateStatus()),
      vscode.languages.registerCodeActionsProvider(
        'ksy',
        { provideCodeActions: (doc, _range, ctx) => this.codeActions(doc, ctx) },
        { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
      ),
    );
    for (const d of vscode.workspace.textDocuments) this.schedule(d, 0);
    this.updateStatus();
  }

  private schedule(doc: vscode.TextDocument, delay: number) {
    if (doc.languageId !== 'ksy') return;
    const key = doc.uri.toString();
    clearTimeout(this.timers.get(key));
    // The entry stays until validation ends, so the status bar shows it as busy.
    const timer = setTimeout(async () => {
      try {
        await this.validate(doc);
      } finally {
        if (this.timers.get(key) === timer) this.timers.delete(key);
        this.updateStatus();
      }
    }, delay);
    this.timers.set(key, timer);
    this.updateStatus();
  }

  private async validate(doc: vscode.TextDocument) {
    const version = doc.version;
    const text = doc.getText();
    const parsed = parsedOf(doc);
    const toRange = (start: number, end: number) => new vscode.Range(doc.positionAt(start), doc.positionAt(end));
    const yaml = (severity: vscode.DiagnosticSeverity) => (e: { pos: [number, number]; message: string }) => {
      const d = new vscode.Diagnostic(
        toRange(e.pos[0], Math.max(e.pos[1], e.pos[0] + 1)),
        e.message.split('\n')[0],
        severity,
      );
      d.source = 'yaml';
      return d;
    };
    const diags = [
      ...parsed.doc.errors.map(yaml(vscode.DiagnosticSeverity.Error)),
      ...parsed.doc.warnings.map(yaml(vscode.DiagnosticSeverity.Warning)),
    ];
    if (!parsed.doc.errors.length) {
      const result = await this.session.templates.compile(doc.uri, text);
      if (doc.isClosed || doc.version !== version) return;
      const err = result.error;
      if (err) {
        const ownId = parsed.root.specId || undefined;
        const target = diagnosticTargetPath(parsed, err, ownId);
        const r = rangeForPath(parsed, text, target);
        const where = err.path?.length ? `/${err.path.join('/')}` : '';
        const imported = isImportedError(err, ownId);
        const message = imported
          ? `In imported spec ${err.file}.ksy${where ? ` at ${where}` : ''}: ${err.message}`
          : r.match === 'ancestor' && where
            ? `${where}: ${err.message}`
            : err.message;
        const d = new vscode.Diagnostic(toRange(r.start, r.end), message);
        d.source = 'kaitai';
        const unresolved = !imported ? unresolvedName(err.message) : undefined;
        if (unresolved) {
          d.code = `unknown-${unresolved.what}`;
          this.fixes.set(d, { path: target, ...unresolved });
        }
        diags.push(d);
      }
    }
    this.collection.set(doc.uri, diags);
  }

  private updateStatus() {
    const doc = vscode.window.activeTextEditor?.document;
    if (doc?.languageId !== 'ksy') {
      this.status.hide();
      return;
    }
    const diags = this.collection.get(doc.uri) ?? [];
    const errors = diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length;
    const warnings = diags.length - errors;
    if (this.timers.has(doc.uri.toString())) {
      this.status.text = '$(sync~spin) KSY';
      this.status.tooltip = 'Compiling…';
    } else if (!diags.length) {
      this.status.text = '$(check) KSY';
      this.status.tooltip = 'Kaitai spec compiled OK';
    } else {
      this.status.text = `$(error) KSY ${errors}${warnings ? ` $(warning) ${warnings}` : ''}`;
      this.status.tooltip = `${errors} error(s), ${warnings} warning(s) — click to open Problems`;
    }
    this.status.show();
  }

  private async codeActions(doc: vscode.TextDocument, ctx: vscode.CodeActionContext): Promise<vscode.CodeAction[]> {
    const fixable = ctx.diagnostics.flatMap((d) => {
      const fix = this.fixes.get(d);
      return fix ? [{ d, fix }] : [];
    });
    if (!fixable.length) return [];
    const imported = (await importedSpecs(doc)).map((s) => s.parsed.root);
    return fixable.flatMap(({ d, fix }) => {
      // Replace the name inside the diagnostic range (leaves `(args)` or `[]` alone).
      const at = doc.getText(d.range).indexOf(fix.name);
      const range =
        at >= 0
          ? new vscode.Range(d.range.start.translate(0, at), d.range.start.translate(0, at + fix.name.length))
          : d.range;
      return suggestionsFor(parsedOf(doc), fix.path, fix.what, fix.name, imported).map((c, i) => {
        const action = new vscode.CodeAction(`Change to '${c}'`, vscode.CodeActionKind.QuickFix);
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(doc.uri, range, c);
        action.diagnostics = [d];
        action.isPreferred = i === 0;
        return action;
      });
    });
  }

  dispose() {
    for (const t of this.timers.values()) clearTimeout(t);
    for (const d of this.disposables) d.dispose();
  }
}
