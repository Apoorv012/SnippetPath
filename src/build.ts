import * as vscode from 'vscode';
import * as path from 'path';
import { parse as parseJsonc } from 'jsonc-parser';
import { BuildIssue, SourceFile, SourceSnippetEntry } from './types';

/** Marker written into every generated file so SnippetPath can safely clean up stale output. */
const GENERATED_MARKER = 'snippetpath:generated';

export interface BuildResult {
  /** Absolute paths of every template file referenced via bodyPath, for watching. */
  templatePaths: Set<string>;
  issues: BuildIssue[];
  generatedCount: number;
}

/**
 * Finds SnippetPath source files in a workspace folder, resolves every `bodyPath`
 * against the template file's current contents, and writes one generated
 * `.code-snippets` file per source file into the configured output directory.
 *
 * Output lands under `.vscode/` (by default) because VS Code auto-loads any
 * `*.code-snippets` file it finds there — no extension API is needed at
 * suggest/insert time, so tabstops, placeholders and variables in the
 * template files are rendered by VS Code's own snippet engine.
 */
export async function buildWorkspaceFolder(
  folder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel
): Promise<BuildResult> {
  const config = vscode.workspace.getConfiguration('snippetPath', folder);
  const sourcePatterns = config.get<string[]>('sources', ['**/*.snippets.json']);
  const excludePatterns = config.get<string[]>('exclude', ['**/node_modules/**', '**/.git/**']);
  const outputDir = config.get<string>('outputDir', '.vscode/snippetpath');

  const outputAbsDir = path.join(folder.uri.fsPath, outputDir);
  const excludeGlob = `{${excludePatterns.join(',')}}`;

  const issues: BuildIssue[] = [];
  const templatePaths = new Set<string>();
  const currentOutputFiles = new Set<string>();

  for (const pattern of sourcePatterns) {
    const relPattern = new vscode.RelativePattern(folder, pattern);
    const sourceUris = await vscode.workspace.findFiles(relPattern, excludeGlob);

    for (const sourceUri of sourceUris) {
      // Never treat our own generated output as a source file.
      if (sourceUri.fsPath.startsWith(outputAbsDir + path.sep)) {
        continue;
      }

      const outputPath = await buildSourceFile(sourceUri, folder, outputAbsDir, templatePaths, issues);
      if (outputPath) {
        currentOutputFiles.add(outputPath);
      }
    }
  }

  await removeStaleGeneratedFiles(outputAbsDir, currentOutputFiles);

  if (issues.length > 0) {
    outputChannel.appendLine(`SnippetPath: ${issues.length} issue(s) found:`);
    for (const issue of issues) {
      outputChannel.appendLine(`  [${issue.sourceFile}] "${issue.snippetName}": ${issue.message}`);
    }
  }

  return { templatePaths, issues, generatedCount: currentOutputFiles.size };
}

async function buildSourceFile(
  sourceUri: vscode.Uri,
  folder: vscode.WorkspaceFolder,
  outputAbsDir: string,
  templatePaths: Set<string>,
  issues: BuildIssue[]
): Promise<string | undefined> {
  const sourceDir = path.dirname(sourceUri.fsPath);
  const raw = await readFileUtf8(sourceUri);
  if (raw === undefined) {
    issues.push({ sourceFile: sourceUri.fsPath, snippetName: '*', message: 'Could not read source file.' });
    return undefined;
  }

  let parsed: SourceFile;
  try {
    const errors: import('jsonc-parser').ParseError[] = [];
    parsed = parseJsonc(raw, errors, { allowTrailingComma: true }) ?? {};
    if (errors.length > 0) {
      issues.push({
        sourceFile: sourceUri.fsPath,
        snippetName: '*',
        message: `JSON parse error at offset ${errors[0].offset}.`
      });
      return undefined;
    }
  } catch (err) {
    issues.push({ sourceFile: sourceUri.fsPath, snippetName: '*', message: `Failed to parse: ${err}` });
    return undefined;
  }

  const outputEntries: SourceFile = {};

  for (const [name, entry] of Object.entries(parsed)) {
    const resolved = await resolveEntry(name, entry, sourceDir, sourceUri.fsPath, templatePaths, issues);
    if (resolved) {
      outputEntries[name] = resolved;
    }
  }

  if (Object.keys(outputEntries).length === 0) {
    return undefined;
  }

  const outputPath = outputPathFor(sourceUri.fsPath, outputAbsDir);
  await writeGeneratedFile(outputPath, sourceUri.fsPath, outputEntries);
  return outputPath;
}

async function resolveEntry(
  name: string,
  entry: SourceSnippetEntry,
  sourceDir: string,
  sourceFilePath: string,
  templatePaths: Set<string>,
  issues: BuildIssue[]
): Promise<SourceSnippetEntry | undefined> {
  if (!entry.bodyPath) {
    if (entry.body === undefined) {
      issues.push({ sourceFile: sourceFilePath, snippetName: name, message: 'Entry has neither "body" nor "bodyPath".' });
      return undefined;
    }
    // Passthrough entry: already a normal snippet, nothing for SnippetPath to do.
    return { ...entry };
  }

  const templateAbsPath = path.isAbsolute(entry.bodyPath)
    ? entry.bodyPath
    : path.resolve(sourceDir, entry.bodyPath);

  templatePaths.add(templateAbsPath);

  const templateUri = vscode.Uri.file(templateAbsPath);
  const content = await readFileUtf8(templateUri);
  if (content === undefined) {
    issues.push({
      sourceFile: sourceFilePath,
      snippetName: name,
      message: `bodyPath "${entry.bodyPath}" does not resolve to a readable file (looked for ${templateAbsPath}).`
    });
    return undefined;
  }

  const { bodyPath, ...rest } = entry;
  return { ...rest, body: fileContentToBodyLines(content) };
}

/**
 * Splits template file contents into the line-array form VS Code snippet
 * bodies use. The file is treated exactly like a snippet body: `$1`,
 * `${1:default}`, `$0`, `$TM_FILENAME`, etc. are left as-is for VS Code's
 * snippet engine to render, and a literal `$` must be escaped as `\$` in
 * the template file itself, same as in a hand-written snippet body.
 */
function fileContentToBodyLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  // Drop a single trailing empty line caused by a final newline in the file.
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function outputPathFor(sourceFilePath: string, outputAbsDir: string): string {
  const base = path.basename(sourceFilePath).replace(/\.snippets\.json$/, '').replace(/\.json$/, '');
  return path.join(outputAbsDir, `${base}.code-snippets`);
}

async function writeGeneratedFile(outputPath: string, sourceFilePath: string, entries: SourceFile): Promise<void> {
  const dir = path.dirname(outputPath);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));

  const header =
    `// ${GENERATED_MARKER}\n` +
    `// Auto-generated by SnippetPath from "${path.basename(sourceFilePath)}". Do not edit by hand.\n` +
    `// Edit the template files referenced by "bodyPath" instead, or the source snippet file itself.\n`;
  const body = header + JSON.stringify(entries, null, 2) + '\n';

  await vscode.workspace.fs.writeFile(vscode.Uri.file(outputPath), Buffer.from(body, 'utf8'));
}

async function removeStaleGeneratedFiles(outputAbsDir: string, currentOutputFiles: Set<string>): Promise<void> {
  let existing: [string, vscode.FileType][];
  try {
    existing = await vscode.workspace.fs.readDirectory(vscode.Uri.file(outputAbsDir));
  } catch {
    return; // Output dir doesn't exist yet; nothing to clean up.
  }

  for (const [name, type] of existing) {
    if (type !== vscode.FileType.File || !name.endsWith('.code-snippets')) {
      continue;
    }
    const fullPath = path.join(outputAbsDir, name);
    if (currentOutputFiles.has(fullPath)) {
      continue;
    }
    const content = await readFileUtf8(vscode.Uri.file(fullPath));
    if (content !== undefined && content.includes(GENERATED_MARKER)) {
      await vscode.workspace.fs.delete(vscode.Uri.file(fullPath));
    }
  }
}

async function readFileUtf8(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return undefined;
  }
}
