import * as vscode from 'vscode';
import * as path from 'path';
import { applyEdits, modify, parse as parseJsonc, ParseError } from 'jsonc-parser';
import { findSourceFiles } from './build';
import { SourceFile } from './types';

interface Language {
  id: string;
  label: string;
  ext: string;
}

const LANGUAGES: Language[] = [
  { id: 'javascript', label: 'JavaScript', ext: '.js' },
  { id: 'typescript', label: 'TypeScript', ext: '.ts' },
  { id: 'python', label: 'Python', ext: '.py' },
  { id: 'java', label: 'Java', ext: '.java' },
  { id: 'csharp', label: 'C#', ext: '.cs' },
  { id: 'cpp', label: 'C++', ext: '.cpp' },
  { id: 'c', label: 'C', ext: '.c' },
  { id: 'go', label: 'Go', ext: '.go' },
  { id: 'rust', label: 'Rust', ext: '.rs' },
  { id: 'php', label: 'PHP', ext: '.php' },
  { id: 'ruby', label: 'Ruby', ext: '.rb' },
  { id: 'html', label: 'HTML', ext: '.html' },
  { id: 'css', label: 'CSS', ext: '.css' },
  { id: 'json', label: 'JSON', ext: '.json' },
  { id: 'shellscript', label: 'Shell Script', ext: '.sh' },
  { id: 'markdown', label: 'Markdown', ext: '.md' },
  { id: 'yaml', label: 'YAML', ext: '.yaml' },
  { id: 'sql', label: 'SQL', ext: '.sql' }
];

const ALL_LANGUAGES = '$(globe) All languages';
const OTHER_LANGUAGE = '$(edit) Other...';
const NEW_FILE = '$(new-file) Create new source file...';
const DEFAULT_NEW_SOURCE = 'snippets/main.snippets.json';

/** Guided flow: scaffolds the source-file entry and the template file, then opens the template. */
export async function newSnippetCommand(triggerRebuild: () => void): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage('SnippetPath: open a folder or workspace first.');
    return;
  }
  const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
  if (!folder) {
    return;
  }

  const sourcePath = await pickSourceFile(folder);
  if (!sourcePath) {
    return;
  }
  const sourceDir = path.dirname(sourcePath);

  const existingText = await readText(sourcePath);
  const existing = existingText === undefined ? {} : parseSource(existingText);
  if (!existing) {
    vscode.window.showErrorMessage(`SnippetPath: ${path.basename(sourcePath)} has JSON errors. Fix them first.`);
    return;
  }
  const existingPrefixes = new Map<string, string>();
  for (const [key, entry] of Object.entries(existing)) {
    for (const p of ([] as string[]).concat(entry?.prefix ?? [])) {
      existingPrefixes.set(p, key);
    }
  }

  const name = await vscode.window.showInputBox({
    title: 'New snippet (1/5)',
    prompt: 'Snippet name (shown in the suggestion list)',
    value: uniqueName('snippet-name', existing),
    ignoreFocusOut: true,
    validateInput: (value) => {
      const v = value.trim();
      if (!v) {
        return 'Name is required.';
      }
      return v in existing ? `A snippet named "${v}" already exists in this file.` : undefined;
    }
  });
  if (name === undefined) {
    return;
  }

  const prefix = await vscode.window.showInputBox({
    title: 'New snippet (2/5)',
    prompt: 'Prefix (what you type to trigger it)',
    ignoreFocusOut: true,
    validateInput: (value) => {
      const v = value.trim();
      if (!v) {
        return { message: 'Prefix is required.', severity: vscode.InputBoxValidationSeverity.Error };
      }
      if (/\s/.test(v)) {
        return { message: 'Prefix cannot contain spaces.', severity: vscode.InputBoxValidationSeverity.Error };
      }
      const owner = existingPrefixes.get(v);
      return owner
        ? { message: `Already used by "${owner}". You can still continue.`, severity: vscode.InputBoxValidationSeverity.Warning }
        : undefined;
    }
  });
  if (prefix === undefined) {
    return;
  }

  const language = await pickLanguage();
  if (!language) {
    return;
  }

  const description = await vscode.window.showInputBox({
    title: 'New snippet (4/5)',
    prompt: 'Description (optional)',
    ignoreFocusOut: true
  });
  if (description === undefined) {
    return;
  }

  const defaultTemplate = `../templates/${slugify(prefix)}${language.ext}`;
  const templateRel = await vscode.window.showInputBox({
    title: 'New snippet (5/5)',
    prompt: 'Template file path (relative to the source file). It is created if it does not exist.',
    value: defaultTemplate,
    ignoreFocusOut: true,
    validateInput: (value) => {
      const v = value.trim();
      if (!v) {
        return 'Path is required.';
      }
      if (path.isAbsolute(v)) {
        return 'Use a path relative to the source file.';
      }
      return isInside(folder.uri.fsPath, path.resolve(sourceDir, v)) ? undefined : 'Path must stay inside the workspace folder.';
    }
  });
  if (templateRel === undefined) {
    return;
  }

  const templateAbs = path.resolve(sourceDir, templateRel.trim());
  if ((await readText(templateAbs)) === undefined) {
    await writeText(templateAbs, '$1\n');
  }

  const entry: Record<string, string> = { prefix: prefix.trim() };
  if (language.scope) {
    entry.scope = language.scope;
  }
  entry.bodyPath = templateRel.trim().replace(/\\/g, '/');
  if (description.trim()) {
    entry.description = description.trim();
  }

  const baseText = existingText ?? '{}\n';
  const edits = modify(baseText, [name.trim()], entry, {
    formattingOptions: { tabSize: 2, insertSpaces: true, eol: '\n' }
  });
  await writeText(sourcePath, applyEdits(baseText, edits));

  triggerRebuild();

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(templateAbs));
  await vscode.window.showTextDocument(doc);
  vscode.window.setStatusBarMessage(`SnippetPath: created "${prefix.trim()}". Write the body, save, then type it.`, 8000);

  const sources = await findSourceFiles(folder);
  if (!sources.some((u) => u.fsPath === sourcePath)) {
    vscode.window.showWarningMessage(
      `${path.basename(sourcePath)} does not match your "snippetPath.sources" setting, so it will not be picked up.`
    );
  }
}

async function pickSourceFile(folder: vscode.WorkspaceFolder): Promise<string | undefined> {
  const candidates: vscode.QuickPickItem[] = [];
  for (const uri of await findSourceFiles(folder)) {
    const text = await readText(uri.fsPath);
    if (text !== undefined && parseSource(text)) {
      candidates.push({ label: path.relative(folder.uri.fsPath, uri.fsPath) });
    }
  }

  let chosen: string | undefined;
  if (candidates.length === 0) {
    chosen = NEW_FILE;
  } else {
    const picked = await vscode.window.showQuickPick([{ label: NEW_FILE }, ...candidates], {
      title: 'New snippet',
      placeHolder: 'Add to an existing source file, or create a new one',
      ignoreFocusOut: true
    });
    chosen = picked?.label;
  }
  if (!chosen) {
    return undefined;
  }
  if (chosen !== NEW_FILE) {
    return path.join(folder.uri.fsPath, chosen);
  }

  const rel = await vscode.window.showInputBox({
    title: 'New source file',
    prompt: 'Path for the new source file (relative to the workspace folder)',
    value: DEFAULT_NEW_SOURCE,
    ignoreFocusOut: true,
    validateInput: (value) => {
      const v = value.trim();
      if (!v) {
        return 'Path is required.';
      }
      if (!v.endsWith('.json')) {
        return 'Must end in .json (default setting expects *.snippets.json).';
      }
      if (path.isAbsolute(v) || !isInside(folder.uri.fsPath, path.resolve(folder.uri.fsPath, v))) {
        return 'Path must be relative and inside the workspace folder.';
      }
      return undefined;
    }
  });
  return rel === undefined ? undefined : path.resolve(folder.uri.fsPath, rel.trim());
}

async function pickLanguage(): Promise<{ scope?: string; ext: string } | undefined> {
  const items: (vscode.QuickPickItem & { lang?: Language })[] = [
    { label: ALL_LANGUAGES },
    ...LANGUAGES.map((lang) => ({ label: lang.label, description: lang.id, lang })),
    { label: OTHER_LANGUAGE }
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: 'New snippet (3/5)',
    placeHolder: 'Which language should this snippet appear in?',
    ignoreFocusOut: true
  });
  if (!picked) {
    return undefined;
  }
  if (picked.lang) {
    return { scope: picked.lang.id, ext: picked.lang.ext };
  }
  if (picked.label === ALL_LANGUAGES) {
    return { ext: '.txt' };
  }

  const scope = await vscode.window.showInputBox({
    title: 'Language ids',
    prompt: 'VS Code language id(s), comma separated (e.g. "cpp,c")',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Enter at least one language id.')
  });
  if (scope === undefined) {
    return undefined;
  }
  const ext = await vscode.window.showInputBox({
    title: 'Template file extension',
    prompt: 'Extension for the template file',
    value: '.txt',
    ignoreFocusOut: true,
    validateInput: (v) => (v.startsWith('.') && v.length > 1 ? undefined : 'Must start with a dot, e.g. ".txt".')
  });
  return ext === undefined ? undefined : { scope: scope.trim(), ext };
}

function parseSource(text: string): SourceFile | undefined {
  const errors: ParseError[] = [];
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || (parsed !== undefined && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)))) {
    return undefined;
  }
  return (parsed ?? {}) as SourceFile;
}

function uniqueName(base: string, existing: SourceFile): string {
  let candidate = base;
  for (let i = 2; candidate in existing; i++) {
    candidate = `${base}-${i}`;
  }
  return candidate;
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'snippet';
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function readText(fsPath: string): Promise<string | undefined> {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath))).toString('utf8');
  } catch {
    return undefined;
  }
}

async function writeText(fsPath: string, content: string): Promise<void> {
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(fsPath)));
  await vscode.workspace.fs.writeFile(vscode.Uri.file(fsPath), Buffer.from(content, 'utf8'));
}
