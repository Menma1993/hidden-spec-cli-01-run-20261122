// main.ts — mend, one patch tool for every AI edit format.
//
// Applies a patch written as a unified diff, SEARCH/REPLACE blocks, a V4A
// patch, or JSON tool calls, to the tree rooted at the working directory.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------- section 5: matching lines at three tiers ----------

function trimEnd(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function trimBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** A file's lines, its line break, and whether it ends with one. */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}
function splitLines(s: string): FileLines {
  if (s === '') return { lines: [], br: '\n', final: false };
  const br = s.includes('\r\n') ? '\r\n' : '\n';
  let body = s;
  let final = false;
  if (body.endsWith(br)) {
    final = true;
    body = body.slice(0, body.length - br.length);
  }
  return { lines: body === '' ? [] : body.split(br), br, final };
}
function joinLines(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEnd(a) === trimEnd(b);
  return trimBoth(a) === trimBoth(b);
}
function findOccurrences(lines: string[], o: string[], tier: number, from = 0, eof = false): number[] {
  const pos: number[] = [];
  const k = o.length;
  for (let i = from; i + k <= lines.length; i++) {
    if (eof && i + k !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (!lineEq(o[j]!, lines[i + j]!, tier)) { ok = false; break; }
    }
    if (ok) pos.push(i);
  }
  return pos;
}
function findTier(lines: string[], o: string[], strict: boolean, from = 0, eof = false): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = findOccurrences(lines, o, t, from, eof);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}
function reindent(text: string, tier: number, f: string, p: string): string {
  if (tier !== 2) return text;
  if (text === '' || text.trim() === '') return text;
  if (!text.startsWith(p)) return text;
  return f + text.slice(p.length);
}

// ---------- hunks: old lines (O) and new lines (N) ----------

type BodyLine = { kind: 'ctx' | 'old' | 'new' | 'bs'; text: string };
interface NLine { text: string; oIdx: number | null; }
interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  lastCtxOrNewBs: boolean;
  lastNewBs: boolean;
}
function buildON(body: BodyLine[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push({ text: b.text, oIdx: o.length - 1 });
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      n.push({ text: b.text, oIdx: null });
    }
  }
  return { o, n };
}
function lastCtxOrNewBs(body: BodyLine[]): boolean {
  for (let i = body.length - 1; i >= 0; i--) {
    const b = body[i]!;
    if (b.kind === 'ctx' || b.kind === 'new') return body[i + 1]?.kind === 'bs';
  }
  return false;
}
function lastNewBs(body: BodyLine[]): boolean {
  for (let i = body.length - 1; i >= 0; i--) {
    const b = body[i]!;
    if (b.kind === 'new') return body[i + 1]?.kind === 'bs';
  }
  return false;
}
function applyHunks(before: string, hunks: Hunk[], strict: boolean, failPath: string): string {
  let { lines, br, final } = splitLines(before);
  let d = 0;
  for (const h of hunks) {
    const o = h.o;
    const n = h.n;
    if (o.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, lines.length));
      const ins = n.map((e) => e.text);
      const atEnd = at === lines.length;
      lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
      if (atEnd && h.lastCtxOrNewBs) final = false;
      d += n.length;
      continue;
    }
    const found = findTier(lines, o, strict);
    if (!found) throw new Fail('no-match', failPath);
    const target = h.a - 1 + d;
    let best = found.positions[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.positions) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const f = leadingWs(lines[best]!);
    const p = leadingWs(o[0]!);
    const rep = n.map((e) => (e.oIdx !== null ? lines[best + e.oIdx]! : reindent(e.text, found.tier, f, p)));
    const endsAtEnd = best + o.length === lines.length;
    lines = [...lines.slice(0, best), ...rep, ...lines.slice(best + o.length)];
    if (endsAtEnd && h.lastCtxOrNewBs) final = false;
    d += n.length - o.length;
  }
  return joinLines(lines, br, final);
}

// ---------- section 6: unified diffs ----------

const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;

function isDiffLine(l: string): boolean {
  return l === 'diff --git' || l.startsWith('diff --git ');
}

function parseDashPath(l: string): string | null {
  let p = l.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function classifyUnifiedLine(l: string): BodyLine | null {
  if (l === '') return { kind: 'ctx', text: '' };
  const c = l[0]!;
  if (c === ' ') return { kind: 'ctx', text: l.slice(1) };
  if (c === '-') return { kind: 'old', text: l.slice(1) };
  if (c === '+') return { kind: 'new', text: l.slice(1) };
  if (c === '\\') return { kind: 'bs', text: l };
  return null;
}

function parseUnified(lines: string[], strict: boolean, moves: { old: string; new: string }[]): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (isDiffLine(l)) {
      const m = DIFF_RE.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const sec: Section = { oldPath: m[1]!, newPath: m[2]!, isCreate: false, isDelete: false, hunks: [] };
      i = parseSection(lines, i + 1, sec, null, null, false);
      edits.push(sectionEdit(sec, strict, moves));
      continue;
    }
    if (l.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) {
      const sec: Section = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [] };
      const dashOld = parseDashPath(l);
      const dashNew = parseDashPath(lines[i + 1]!);
      i = parseSection(lines, i + 2, sec, dashOld, dashNew, true);
      edits.push(sectionEdit(sec, strict, moves));
      continue;
    }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i++;
  }
  return edits;
}

function parseSection(lines: string[], i: number, sec: Section, dashOld0: string | null, dashNew0: string | null, haveDash0: boolean): number {
  const n = lines.length;
  let dashOld = dashOld0;
  let dashNew = dashNew0;
  let haveDash = haveDash0;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  const diffOld = sec.oldPath;
  const diffNew = sec.newPath;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('@@')) break;
    if (isDiffLine(l)) break;
    if (l.startsWith('--- ')) {
      if (i + 1 < n && lines[i + 1]!.startsWith('+++ ')) {
        if (haveDash) break;
        dashOld = parseDashPath(l);
        dashNew = parseDashPath(lines[i + 1]!);
        haveDash = true;
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('+++ ')) {
      if (!haveDash) dashNew = parseDashPath(l);
      i++;
      continue;
    }
    if (l.startsWith('rename from ')) { renameFrom = l.slice(12).trim(); i++; continue; }
    if (l.startsWith('rename to ')) { renameTo = l.slice(10).trim(); i++; continue; }
    if (l === 'new file mode' || l.startsWith('new file mode ')) { sec.isCreate = true; i++; continue; }
    if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) { sec.isDelete = true; i++; continue; }
    i++;
  }
  sec.oldPath = haveDash ? dashOld : (renameFrom ?? diffOld);
  sec.newPath = haveDash ? dashNew : (renameTo ?? diffNew);
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('@@')) {
      const m = HUNK_RE.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const body: BodyLine[] = [];
      i++;
      while (i < n) {
        const b = lines[i]!;
        if (isDiffLine(b)) break;
        if (b.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) break;
        if (b.startsWith('@@')) break;
        const bl = classifyUnifiedLine(b);
        if (!bl) break;
        body.push(bl);
        i++;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') body.pop();
      const { o, n: nn } = buildON(body);
      sec.hunks.push({ a: Number(m[1]), o, n: nn, lastCtxOrNewBs: lastCtxOrNewBs(body), lastNewBs: lastNewBs(body) });
      continue;
    }
    if (isDiffLine(l)) break;
    if (l.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) break;
    i++;
  }
  return i;
}

function sectionEdit(sec: Section, strict: boolean, moves: { old: string; new: string }[]): Edit {
  const oldP = sec.oldPath;
  const newP = sec.newPath;
  const isCreate = oldP === null || sec.isCreate;
  const isDelete = !isCreate && (newP === null || sec.isDelete);
  if (isCreate) {
    const path = newP ?? '';
    const plus: string[] = [];
    let noFinal = false;
    for (const h of sec.hunks) {
      let hasPlus = false;
      for (const e of h.n) {
        if (e.oIdx === null) { plus.push(e.text); hasPlus = true; }
      }
      if (hasPlus) noFinal = h.lastNewBs;
    }
    const text = plus.length === 0 ? '' : plus.join('\n') + (noFinal ? '' : '\n');
    return (t) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (t.get(path) !== null) throw new Fail('exists', path);
      t.now.set(path, text);
    };
  }
  if (isDelete) {
    const path = oldP ?? '';
    return (t) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (t.get(path) === null) throw new Fail('missing', path);
      t.now.set(path, null);
    };
  }
  if (oldP !== null && newP !== null && oldP !== newP) {
    return (t) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = t.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (t.get(newP) !== null) throw new Fail('exists', newP);
      const result = applyHunks(before, sec.hunks, strict, oldP);
      t.now.set(oldP, null);
      t.now.set(newP, result);
      moves.push({ old: oldP, new: newP });
    };
  }
  const path = oldP ?? '';
  return (t) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const before = t.get(path);
    if (before === null) throw new Fail('missing', path);
    t.now.set(path, applyHunks(before, sec.hunks, strict, path));
  };
}

// ---------- section 7: SEARCH/REPLACE blocks ----------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  let prevEnd = 0;
  let lastPath: string | null = null;
  while (i < n) {
    let s = -1;
    for (let j = i; j < n; j++) {
      if (trimEnd(lines[j]!) === '<<<<<<< SEARCH') { s = j; break; }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (lastPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = lastPath;
    }
    let eq = -1;
    for (let j = s + 1; j < n; j++) {
      const l = trimEnd(lines[j]!);
      if (l === '=======') { eq = j; break; }
      if (l === '>>>>>>> REPLACE' || l === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      const l = trimEnd(lines[j]!);
      if (l === '>>>>>>> REPLACE') { rep = j; break; }
      if (l === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    lastPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (t) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (t.get(path) !== null) throw new Fail('exists', path);
      t.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = t.get(path);
    if (before === null) throw new Fail('missing', path);
    const { lines, br, final } = splitLines(before);
    const found = findTier(lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const at = found.positions[0]!;
    const f = leadingWs(lines[at]!);
    const p = leadingWs(oldLines[0]!);
    const rep = newLines.map((x) => reindent(x, found.tier, f, p));
    const out = [...lines.slice(0, at), ...rep, ...lines.slice(at + oldLines.length)];
    t.now.set(path, joinLines(out, br, final));
  };
}

// ---------- section 8: V4A patches ----------

interface V4aChunk { anchor: string | null; eof: boolean; o: string[]; n: NLine[]; }

function isV4aSectionStart(b: string): boolean {
  return b.startsWith('*** Add File: ') || b.startsWith('*** Delete File: ') || b.startsWith('*** Update File: ') || b.trim() === '*** End Patch';
}

function classifyV4aLine(l: string): BodyLine | null {
  if (l === '') return { kind: 'ctx', text: '' };
  const c = l[0]!;
  if (c === ' ') return { kind: 'ctx', text: l.slice(1) };
  if (c === '-') return { kind: 'old', text: l.slice(1) };
  if (c === '+') return { kind: 'new', text: l.slice(1) };
  return null;
}

function parseV4a(lines: string[], strict: boolean, moves: { old: string; new: string }[]): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) { last = k; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) { i++; continue; }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      i++;
      const body: string[] = [];
      while (i < last) {
        const b = lines[i]!;
        if (isV4aSectionStart(b)) break;
        if (b.startsWith('+')) { body.push(b.slice(1)); i++; }
        else if (blank(b)) { body.push(''); i++; }
        else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      edits.push(v4aAddEdit(path, body));
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last) {
        const b = lines[i]!;
        if (isV4aSectionStart(b)) break;
        if (blank(b)) { i++; continue; }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const updateLine = i + 1;
      const path = l.slice('*** Update File: '.length).trim();
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const parsed = parseV4aChunks(lines, i, last);
      i = parsed.next;
      if (parsed.list.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, parsed.list, strict, moves));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function parseV4aChunks(lines: string[], i: number, last: number): { list: V4aChunk[]; next: number } {
  interface Raw { anchor: string | null; eof: boolean; body: BodyLine[]; }
  const raw: Raw[] = [];
  let cur: Raw | null = null;
  let firstChunk = true;
  while (i < last) {
    const b = lines[i]!;
    if (isV4aSectionStart(b)) break;
    if (b.startsWith('@@')) {
      if (cur) raw.push(cur);
      const anchorText = b.slice(2).trim();
      cur = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
      firstChunk = false;
      i++;
      continue;
    }
    if (b.trim() === '*** End of File') {
      if (!cur) throw new Exit2(`error: parse ${i + 1}`);
      cur.eof = true;
      raw.push(cur);
      cur = null;
      firstChunk = false;
      i++;
      continue;
    }
    if (blank(b) && !cur && !firstChunk) { i++; continue; }
    const bl = classifyV4aLine(b);
    if (bl) {
      if (!cur) {
        if (!firstChunk) throw new Exit2(`error: parse ${i + 1}`);
        cur = { anchor: null, eof: false, body: [] };
      }
      cur.body.push(bl);
      firstChunk = false;
      i++;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (cur) raw.push(cur);
  if (raw.length > 0) {
    const lastRaw = raw[raw.length - 1]!;
    while (lastRaw.body.length > 0) {
      const b = lastRaw.body[lastRaw.body.length - 1]!;
      if (b.kind === 'ctx' && b.text === '') lastRaw.body.pop();
      else break;
    }
  }
  const list = raw.map((r) => {
    const { o, n } = buildON(r.body);
    return { anchor: r.anchor, eof: r.eof, o, n };
  });
  return { list, next: i };
}

function v4aAddEdit(path: string, body: string[]): Edit {
  const text = body.length === 0 ? '' : body.join('\n') + '\n';
  return (t) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (t.get(path) !== null) throw new Fail('exists', path);
    t.now.set(path, text);
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (t) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (t.get(path) === null) throw new Fail('missing', path);
    t.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean, moves: { old: string; new: string }[]): Edit {
  return (t) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = t.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && t.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let { lines, br, final } = splitLines(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        let found = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const tt of tiers) {
          for (let j = cursor; j < lines.length; j++) {
            if (lineEq(chunk.anchor, lines[j]!, tt)) { found = j; break; }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      if (chunk.o.length === 0) {
        const at = chunk.eof ? lines.length : cursor;
        const ins = chunk.n.map((e) => e.text);
        lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
        cursor = at + ins.length;
        continue;
      }
      const found = findTier(lines, chunk.o, strict, cursor, chunk.eof);
      if (!found) throw new Fail('no-match', path);
      const at = found.positions[0]!;
      const f = leadingWs(lines[at]!);
      const p = leadingWs(chunk.o[0]!);
      const rep = chunk.n.map((e) => (e.oIdx !== null ? lines[at + e.oIdx]! : reindent(e.text, found.tier, f, p)));
      lines = [...lines.slice(0, at), ...rep, ...lines.slice(at + chunk.o.length)];
      cursor = at + rep.length;
    }
    const result = joinLines(lines, br, final);
    if (moveTo !== null) {
      t.now.set(path, null);
      t.now.set(moveTo, result);
      moves.push({ old: path, new: moveTo });
    } else {
      t.now.set(path, result);
    }
  };
}

// ---------- section 9: JSON edits ----------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- section 10: order, atomicity, output ----------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: { old: string; new: string }[] = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict, moves);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rowByPath = new Map<string, string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rowByPath.set(p, was === null ? 'A' : now === null ? 'D' : 'M');
  }
  const used = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const m of moves) {
    if (used.has(m.old) || used.has(m.new)) continue;
    if (rowByPath.get(m.old) !== 'D' || rowByPath.get(m.new) !== 'A') continue;
    used.add(m.old);
    used.add(m.new);
    rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
  }
  for (const [p, k] of rowByPath) {
    if (used.has(p)) continue;
    rows.push({ key: p, line: `${k} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out: string[] = rows.map((r) => r.line);
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...out, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
