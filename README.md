# SnippetPath

Keep VS Code snippet **bodies** in real files, not in escaped JSON string arrays.

## The problem

A normal VS Code snippet looks like this:

```json
"C++ Boilerplate": {
  "prefix": "cpp",
  "body": [
    "#include <bits/stdc++.h>",
    "using namespace std;",
    "",
    "int main(){",
    "\t$1",
    "\treturn 0;",
    "}"
  ],
  "description": "Basic C++ boilerplate code"
}
```

That's fine for a five-line snippet. It stops being fine once the body is a
150-line competitive-programming template, a React component skeleton, or
anything you'd normally want to open, edit, and run a formatter/linter over.
Every line has to live inside a JSON string, with `\t`, `\"`, and `\\`
escaping getting in the way of just... writing code.

## The idea

SnippetPath lets you write the template as an ordinary file:

```text
templates/
├── cpp.cpp
├── cpp_segment_tree.cpp
└── python.py
```

and reference it from a snippet definition with `bodyPath` instead of `body`:

```json
"C++ Boilerplate": {
  "prefix": "cpp",
  "bodyPath": "../templates/cpp.cpp",
  "description": "Basic C++ boilerplate code"
}
```

Type `cpp` + Tab/Enter in a C++ file, and the contents of `cpp.cpp` are
inserted exactly like a normal snippet body — tabstops, placeholders, and
variables included.

The template file is the source of truth for *what gets inserted*. The
snippet definition file only carries metadata: prefix, description, scope,
and the path to the file.

## How it works

VS Code has no extension point for "snippet body lives in another file" —
snippets are just static JSON that the built-in engine reads and expands.
So rather than intercepting completion or re-implementing snippet expansion,
SnippetPath does the simplest thing that works with VS Code's own machinery:

1. You write **source files** (`*.snippets.json` by default) using the same
   shape as a normal `.code-snippets` file, except entries use `bodyPath`
   instead of `body`.
2. SnippetPath reads each source file, resolves every `bodyPath`, reads the
   referenced template file, and splits it into the line-array form VS Code
   snippet bodies use.
3. It writes the result as a real, plain `.code-snippets` file into
   `.vscode/` (as `snippetpath.*.code-snippets`) in your workspace.
4. VS Code auto-loads any `*.code-snippets` file under `.vscode/` on its
   own — no API call, no completion provider, nothing SnippetPath has to do
   at suggestion or insertion time. Once the file is generated, expansion is
   handled entirely by VS Code's native snippet engine, so `$1`,
   `${1:default}`, `$0`, `$TM_FILENAME`, choice syntax, etc. all work exactly
   as they would in a hand-written snippet.
5. SnippetPath watches both the source files and every template file they
   reference, and regenerates automatically on save. No reload required.

This also means the generated `.code-snippets` files keep working even at
moments the extension isn't active — they're just normal VS Code snippet
files.

### Why not a completion provider?

An alternative design would register a `CompletionItemProvider` that reads
the template file live and returns a `SnippetString` on demand. It was
rejected for this MVP because:

- It duplicates VS Code's own prefix-matching, filtering, and snippet
  variable/placeholder resolution instead of reusing it.
- It runs alongside (not instead of) the built-in snippet suggestions, so
  you'd likely see the same prefix suggested twice unless the built-in
  snippet contribution point is left empty and *everything* is reimplemented
  through the provider — including tie-breaking with other extensions'
  completion providers, sorting, and non-textmate languages.
- Generating real snippet files is transparent and debuggable: at any point
  you can open `.vscode/snippetpath.*.code-snippets` and see exactly what VS
  Code will insert.

## Usage

1. Install the extension.
2. Create a source file anywhere in your workspace matching
   `**/*.snippets.json` (e.g. `snippets/competitive.snippets.json`):

   ```json
   {
     "C++ Boilerplate": {
       "prefix": "cpp",
       "scope": "cpp",
       "bodyPath": "../templates/cpp.cpp",
       "description": "Basic C++ boilerplate code"
     }
   }
   ```

3. Save it. SnippetPath generates
   `.vscode/snippetpath.competitive.code-snippets` automatically.
4. Open a `.cpp` file, type `cpp`, accept the suggestion.
5. Edit `templates/cpp.cpp` any time — the generated snippet updates on
   save, with no reload needed.

You can also run **SnippetPath: Rebuild Snippets** from the Command Palette
to force a full rebuild.

A working example lives in [`example/`](example/) — open that folder in VS
Code (or press F5 in this repo to launch an Extension Development Host on
it) to try `cpp`, `segtree`, and `pymain`.

## Source file format

A SnippetPath source file is a JSON object with the same shape as a
`.code-snippets` file. Each entry supports every field a normal snippet
does (`prefix`, `description`, `scope`, ...), plus:

| Field      | Required | Meaning                                                        |
|------------|----------|------------------------------------------------------------------|
| `bodyPath` | one of `body`/`bodyPath` | Path to the template file whose contents become the snippet body |
| `body`     | one of `body`/`bodyPath` | A normal inline snippet body, passed through unchanged           |

Mixing `bodyPath` entries and normal `body` entries in the same source file
is fine — SnippetPath only touches entries that declare `bodyPath`.

## Path resolution

**`bodyPath` is resolved relative to the source file that references it**,
not the workspace root and not the generated output file. This is the same
convention as a relative `import`/`#include`: the path is anchored to the
file doing the referencing, so a source file and the templates it points at
can be moved together as a unit, and multiple source files can each use
their own short relative paths (`../templates/x.cpp`) without needing to
know where the workspace root is.

An absolute path in `bodyPath` is used as-is.

## Configuration

| Setting                   | Default                                   | Meaning                                                        |
|----------------------------|-------------------------------------------|------------------------------------------------------------------|
| `snippetPath.sources`      | `["**/*.snippets.json"]`                  | Glob(s), per workspace folder, matching source files            |
| `snippetPath.exclude`      | `["**/node_modules/**", "**/.git/**"]`    | Glob(s) excluded from the source search                         |
| `snippetPath.outputDir`    | `.vscode`                                 | Where generated `.code-snippets` files are written (must be `.vscode` itself — VS Code doesn't scan subdirectories of it) |

## Snippet variables and placeholders

Because the generated file is a real VS Code snippet, the template file is
authored **as a snippet body**, not as raw literal code:

- `$1`, `$2`, `${1:default text}`, `$0`, choice syntax `${1|a,b,c|}`, and
  built-in variables like `$TM_FILENAME`, `$CURRENT_YEAR`, `$WORKSPACE_NAME`
  all work directly, exactly as they would in a hand-written `body` array.
- A literal `$` in your template must be escaped as `\$`, same as in any
  other VS Code snippet body.

This keeps the mental model simple: "the file's contents become the body
array, line by line" — nothing is auto-escaped or auto-detected on your
behalf.

## Scope: workspace snippets only (for now)

SnippetPath currently generates **workspace snippets** (written under
`.vscode/` in each open workspace folder). It does not currently generate
into VS Code's global/user snippets directory.

This is a deliberate scope decision, not an oversight:

- The user snippets directory's location differs by OS and by which VS
  Code variant is installed (Code, Code - Insiders, VS Codium, Cursor,
  etc.), so writing to it reliably needs per-variant path detection that
  adds real surface area for an MVP.
- Workspace snippets cover the primary use case this extension targets —
  large, project- or language-specific boilerplate — without needing to
  reach outside the workspace at all.

If you want the same templates available globally across projects, put the
generated `.vscode/snippetpath.*.code-snippets` file's *source* file
(`*.snippets.json`) in a shared location and symlink or copy it into each
workspace's source glob for now. Native global-snippet support may be added
later.

## Limitations

- **Workspace-only** (see above) — no global/user snippet generation yet.
- **Full rebuild on change.** Any change to a source file or a referenced
  template triggers a rebuild of every source file in the workspace. This
  is simple and fast enough for realistic snippet collections (tens to low
  hundreds of entries); it is not designed for huge generated snippet sets.
- **Generated files are derived output.** Don't hand-edit
  `.vscode/snippetpath.*.code-snippets` — it's overwritten on every rebuild.
  Edit the source file or the template file instead.
- **Committing generated files is optional but recommended for teammates
  without the extension.** If a teammate opens the workspace without
  SnippetPath installed, a `.vscode/snippetpath.*.code-snippets` file already
  committed to the repo still works (VS Code loads it natively); it just
  won't stay in sync with template edits until SnippetPath is installed. If
  you'd rather not commit generated output, gitignore
  `.vscode/snippetpath.*.code-snippets` and require the extension for anyone
  using the snippets.
- **No snippet-body linting.** SnippetPath doesn't validate that your
  template file is well-formed snippet syntax (e.g. balanced `${...}`); a
  malformed template will simply fail to expand the way you expect, the
  same way a malformed hand-written `body` would.

## Development

```bash
npm install
npm run compile   # or: npm run watch
```

Press <kbd>F5</kbd> in this repo to launch an Extension Development Host
against [`example/`](example/).
