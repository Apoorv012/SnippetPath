import * as vscode from 'vscode';
import * as path from 'path';
import { buildWorkspaceFolder } from './build';
import { newSnippetCommand } from './newSnippet';

// One set of watchers per workspace folder, keyed by folder.uri.toString().
const folderWatchers = new Map<string, vscode.Disposable[]>();

let outputChannel: vscode.OutputChannel;
let extensionContext: vscode.ExtensionContext;
let hasCheckedScaffold = false;

const SCAFFOLD_DISMISSED_KEY = 'snippetpath.scaffoldPromptDismissed';
let rebuildTimer: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  outputChannel = vscode.window.createOutputChannel('SnippetPath');
  context.subscriptions.push(outputChannel);

  context.subscriptions.push(
    vscode.commands.registerCommand('snippetpath.rebuild', () => scheduleRebuild(0))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('snippetpath.newSnippet', () => newSnippetCommand(() => scheduleRebuild(0)))
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleRebuild())
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('snippetPath')) {
        scheduleRebuild();
      }
    })
  );

  context.subscriptions.push({
    dispose: () => {
      for (const disposables of folderWatchers.values()) {
        disposables.forEach((d) => d.dispose());
      }
      folderWatchers.clear();
    }
  });

  scheduleRebuild(0);
}

export function deactivate(): void {
  if (rebuildTimer) {
    clearTimeout(rebuildTimer);
  }
}

/** Debounces rebuilds so a burst of file-save events triggers one build, not several. */
function scheduleRebuild(delayMs = 200): void {
  if (rebuildTimer) {
    clearTimeout(rebuildTimer);
  }
  rebuildTimer = setTimeout(() => {
    rebuildAll().catch((err) => outputChannel.appendLine(`SnippetPath: rebuild failed: ${err}`));
  }, delayMs);
}

async function rebuildAll(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  let totalGenerated = 0;
  let totalIssues = 0;
  let totalSourceFiles = 0;

  for (const folder of folders) {
    const result = await buildWorkspaceFolder(folder, outputChannel);
    totalGenerated += result.generatedCount;
    totalIssues += result.issues.length;
    totalSourceFiles += result.sourceFileCount;
    setupWatchersForFolder(folder, result.templatePaths);
  }

  outputChannel.appendLine(
    `SnippetPath: rebuilt ${totalGenerated} snippet file(s)` +
      (totalIssues > 0 ? ` with ${totalIssues} issue(s) — see above.` : '.')
  );

  if (!hasCheckedScaffold && folders.length > 0) {
    hasCheckedScaffold = true;
    if (totalSourceFiles === 0) {
      void offerFirstSnippet();
    }
  }

  if (totalIssues > 0) {
    vscode.window.setStatusBarMessage(`SnippetPath: ${totalIssues} snippet issue(s), see "SnippetPath" output`, 8000);
  }
}

async function offerFirstSnippet(): Promise<void> {
  if (extensionContext.workspaceState.get<boolean>(SCAFFOLD_DISMISSED_KEY)) {
    return;
  }
  const createLabel = 'Create Snippet';
  const dismissLabel = "Don't ask again";
  const choice = await vscode.window.showInformationMessage(
    'No SnippetPath snippets found in this workspace yet. Create your first one?',
    createLabel,
    dismissLabel
  );
  if (choice === createLabel) {
    await vscode.commands.executeCommand('snippetpath.newSnippet');
  } else if (choice === dismissLabel) {
    await extensionContext.workspaceState.update(SCAFFOLD_DISMISSED_KEY, true);
  }
}

function setupWatchersForFolder(folder: vscode.WorkspaceFolder, templatePaths: Set<string>): void {
  const key = folder.uri.toString();
  const previous = folderWatchers.get(key);
  if (previous) {
    previous.forEach((d) => d.dispose());
  }

  const config = vscode.workspace.getConfiguration('snippetPath', folder);
  const sourcePatterns = config.get<string[]>('sources', ['**/*.snippets.json']);

  const disposables: vscode.Disposable[] = [];

  // Watch the source snippet definition files themselves.
  for (const pattern of sourcePatterns) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, pattern));
    watcher.onDidChange(() => scheduleRebuild());
    watcher.onDidCreate(() => scheduleRebuild());
    watcher.onDidDelete(() => scheduleRebuild());
    disposables.push(watcher);
  }

  // Watch every template file currently referenced via bodyPath.
  for (const templatePath of templatePaths) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(templatePath)), path.basename(templatePath))
    );
    watcher.onDidChange(() => scheduleRebuild());
    watcher.onDidCreate(() => scheduleRebuild());
    watcher.onDidDelete(() => scheduleRebuild());
    disposables.push(watcher);
  }

  folderWatchers.set(key, disposables);
}
