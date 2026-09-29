/**
 * Shape of a single entry inside a SnippetPath source file.
 *
 * This mirrors VS Code's own snippet entry shape, plus one extra field:
 * `bodyPath`. Exactly one of `body` / `bodyPath` must be present.
 */
export interface SourceSnippetEntry {
  prefix: string | string[];
  description?: string;
  scope?: string;
  bodyPath?: string;
  body?: string | string[];
  [extra: string]: unknown;
}

/** A SnippetPath source file: snippet name -> entry, same shape as a .code-snippets file. */
export type SourceFile = Record<string, SourceSnippetEntry>;

/** One resolved template file that a generated snippet depends on. */
export interface TemplateDependency {
  /** Absolute path to the template file on disk. */
  absPath: string;
}

export interface BuildIssue {
  sourceFile: string;
  snippetName: string;
  message: string;
}
