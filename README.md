# mend

One patch tool for every AI edit format.

`mend` applies a patch to the tree rooted at the working directory, no matter
which format the patch is written in. It detects the format automatically, or
you can force one with `--format`.

## Formats

- **Unified diff** — `diff --git` / `---` / `+++` hunks, with `*** Update File`,
  `*** Add File`, `*** Delete File`, `*** Move to` and `*** End Patch` markers.
- **SEARCH/REPLACE** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` blocks.
- **V4A** — `*** Begin Patch` ... `*** End Patch` patches.
- **JSON** — one JSON tool call per line, or a JSON array of calls:
  `str_replace`, `create`, `insert`, `delete`, `rename`, `move`.

Matching is tiered: exact lines first, then trailing-whitespace-insensitive,
then fully-trimmed — fuzzy matching only kicks in when the exact tier finds
nothing. A patch is applied atomically per edit: if one edit fails, the tree
is left as it was before that edit.

## Usage

```
node main.ts [options] [PATCH]
```

- `PATCH` is a patch file; omit it (or pass `-`) to read the patch from stdin.
- `--format=auto|unified|search-replace|v4a|json` (default `auto`).
- `--check` — validate and report without writing anything.
- `--strict` — stricter parsing of the patch format.

On success it prints one line per changed file (`A`, `M`, `D`, or
`R old -> new`, sorted by path) and a final `ok: N file(s)` line, and exits
with code 0. Failed edits print `error: <code> <path>` lines plus a
`failed: M of N edits` summary and exit with code 1. Usage and parse errors
exit with code 2.

## Requirements

Node 22, standard library only — no dependencies to install.

## Trials

In a trial run the grader sets `MAKEFUN_ENV_URL` and `main.ts` hands over to
`runner.ts`, which fetches the checks and runs this file on each one. Keep
`runner.ts` and the hand-over at the bottom of `main.ts` as they are.
