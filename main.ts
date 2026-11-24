// main.ts is mend, the CLI SPEC.md specifies (MIT). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`. Sections 1 to 4, 9 and 10 come from the kit's starter. Section 5 (matching
// tiers) and section 6 (unified diffs) are implemented here; sections 7 (SEARCH/REPLACE) and 8 (V4A) follow.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are.

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
  readonly moves: [string, string][] = [];
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

// ---------- documents: files, their line break and their lines (section 3) ----------

interface Doc {
  lines: string[];
  br: string;
  final: boolean;
}

function readDoc(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    final = true;
    parts.pop();
  }
  return { lines: parts, br, final };
}

function docText(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

// ---------- matching lines at three tiers (section 5) ----------

const rtrim = (s: string): string => s.replace(/[ \t]+$/, '');
const btrim = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function eqLine(tier: number, a: string, b: string): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrim(a) === rtrim(b);
  return btrim(a) === btrim(b);
}

/** Positions where O matches the file's lines at `tier`, in order; occurrences may overlap. */
function positionsOf(fileLines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + o.length <= fileLines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!eqLine(tier, fileLines[i + j]!, o[j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once. */
function tierOf(fileLines: string[], o: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const max = strict ? 0 : 2;
  for (let tier = 0; tier <= max; tier += 1) {
    const positions = positionsOf(fileLines, o, tier);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

type BodyKind = 'ctx' | 'old' | 'new';

interface BodyLine {
  kind: BodyKind;
  text: string;
  noEol: boolean;
}

/** Replace O at `pos` with the body's lines: context from the file, new lines from the patch. */
function applyBody(doc: Doc, pos: number, o: string[], body: BodyLine[], tier: number): void {
  const reind = tier === 2 && o.length > 0;
  const f = reind ? leadWs(doc.lines[pos]!) : '';
  const p = reind ? leadWs(o[0]!) : '';
  const out: string[] = [];
  let oi = 0;
  for (const b of body) {
    if (b.kind === 'ctx') {
      out.push(doc.lines[pos + oi]!);
      oi += 1;
    } else if (b.kind === 'old') {
      oi += 1;
    } else {
      out.push(reind && b.text.trim() !== '' && b.text.startsWith(p) ? f + b.text.slice(p.length) : b.text);
    }
  }
  doc.lines.splice(pos, o.length, ...out);
}

const oOf = (body: BodyLine[]): string[] => body.filter((b) => b.kind !== 'new').map((b) => b.text);
const nLen = (body: BodyLine[]): number => body.filter((b) => b.kind !== 'old').length;

// ---------- unified diffs (section 6) ----------

interface UHunk {
  a: number;
  body: BodyLine[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const GIT = /^diff --git a\/(.+?) b\/(.+)$/;

function stripPrefix(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function headerPath(rest: string): string {
  const tab = rest.indexOf('\t');
  const text = (tab >= 0 ? rest.slice(0, tab) : rest).trim();
  if (text === '/dev/null') return text;
  return stripPrefix(text);
}

function rawBody(lines: string[], from: number, n: number): { body: BodyLine[]; next: number } {
  const raw: { kind: BodyKind | 'marker'; text: string; empty: boolean }[] = [];
  let i = from;
  while (i < n) {
    const b = lines[i]!;
    if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (b.startsWith('diff --git ')) break;
    if (b === '') {
      raw.push({ kind: 'ctx', text: '', empty: true });
      i += 1;
      continue;
    }
    const c = b[0];
    if (c === ' ') raw.push({ kind: 'ctx', text: b.slice(1), empty: false });
    else if (c === '-') raw.push({ kind: 'old', text: b.slice(1), empty: false });
    else if (c === '+') raw.push({ kind: 'new', text: b.slice(1), empty: false });
    else if (c === '\\') raw.push({ kind: 'marker', text: b, empty: false });
    else break;
    i += 1;
  }
  while (raw.length > 0) {
    const last = raw[raw.length - 1]!;
    if (last.kind !== 'ctx' || !last.empty) break;
    raw.pop();
  }
  const body: BodyLine[] = [];
  for (const r of raw) {
    if (r.kind === 'marker') {
      const last = body[body.length - 1];
      if (last !== undefined) last.noEol = true;
      continue;
    }
    body.push({ kind: r.kind, text: r.text, noEol: false });
  }
  return { body, next: i };
}

/** Apply a section's hunks to a document, in order. Throws Fail on the first hunk that cannot be applied. */
function applyHunks(doc: Doc, hunks: UHunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const o = oOf(h.body);
    const nl = nLen(h.body);
    let pos: number;
    let tier = 0;
    if (o.length > 0) {
      const found = tierOf(doc.lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      tier = found.tier;
      const target = h.a - 1 + d;
      pos = found.positions[0]!;
      let best = Math.abs(pos - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < best) {
          best = dist;
          pos = p;
        }
      }
    } else {
      pos = Math.min(Math.max(h.a + d, 0), doc.lines.length);
    }
    const atEnd = pos + o.length === doc.lines.length;
    if (atEnd) {
      let lastNoEol = false;
      for (const b of h.body) if (b.kind !== 'old') lastNoEol = b.noEol;
      doc.final = !lastNoEol;
    }
    applyBody(doc, pos, o, h.body, tier);
    d += nl - o.length;
  }
}

function createdText(lines: string[], noEol: boolean): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (noEol ? '' : '\n');
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    const isGit = l.startsWith('diff --git ');
    if (!isGit && !(l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
      i += 1;
      continue;
    }
    let pairOld: string | undefined;
    let pairNew: string | undefined;
    let renameFrom: string | undefined;
    let renameTo: string | undefined;
    let createFlag = false;
    let deleteFlag = false;
    let diffOld: string | undefined;
    let diffNew: string | undefined;
    let j: number;
    if (isGit) {
      const m = GIT.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      diffOld = m[1]!;
      diffNew = m[2]!;
      j = i + 1;
    } else {
      pairOld = headerPath(l.slice(4));
      pairNew = headerPath(lines[i + 1]!.slice(4));
      j = i + 2;
    }
    while (j < n) {
      const h = lines[j]!;
      if (h.startsWith('@@')) break;
      if (h.startsWith('diff --git ')) break;
      if (h.startsWith('--- ')) {
        if ((lines[j + 1] ?? '').startsWith('+++ ')) {
          pairOld = headerPath(h.slice(4));
          pairNew = headerPath(lines[j + 1]!.slice(4));
          j += 2;
          continue;
        }
        throw new Exit2(`error: parse ${j + 2}`);
      }
      if (h.startsWith('new file mode')) createFlag = true;
      else if (h.startsWith('deleted file mode')) deleteFlag = true;
      else if (h.startsWith('rename from ')) renameFrom = h.slice('rename from '.length).trim();
      else if (h.startsWith('rename to ')) renameTo = h.slice('rename to '.length).trim();
      j += 1;
    }
    const oldP = pairOld ?? renameFrom ?? diffOld;
    const newP = pairNew ?? renameTo ?? diffNew;
    const isCreate = createFlag || oldP === '/dev/null';
    const isDelete = deleteFlag || newP === '/dev/null';
    const hunks: UHunk[] = [];
    if (isDelete) {
      // A deletion's hunks are not read (section 6): only its end matters.
      while (j < n) {
        const h = lines[j]!;
        if (h.startsWith('diff --git ')) break;
        if (h.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        j += 1;
      }
    } else {
      while (j < n) {
        const h = lines[j]!;
        if (h.startsWith('diff --git ')) break;
        if (h.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (h.startsWith('@@')) {
          const m = HUNK.exec(h);
          if (m === null) throw new Exit2(`error: parse ${j + 1}`);
          const a = parseInt(m[1]!, 10);
          const got = rawBody(lines, j + 1, n);
          hunks.push({ a, body: got.body });
          j = got.next;
          continue;
        }
        j += 1;
      }
    }
    i = j;
    if (isCreate) {
      const target = newP ?? '';
      edits.push((tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) !== null) throw new Fail('exists', target);
        const out: string[] = [];
        let noEol = false;
        for (const h of hunks) {
          for (const b of h.body) {
            if (b.kind !== 'new') continue;
            out.push(b.text);
            noEol = b.noEol;
          }
        }
        tree.now.set(target, createdText(out, noEol));
      });
      continue;
    }
    if (isDelete) {
      const target = oldP ?? '';
      edits.push((tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) === null) throw new Fail('missing', target);
        tree.now.set(target, null);
      });
      continue;
    }
    if (oldP === undefined || newP === undefined) continue;
    if (oldP !== newP) {
      edits.push((tree) => {
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (!safe(newP)) throw new Fail('unsafe', newP);
        const text = tree.get(oldP);
        if (text === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const doc = readDoc(text);
        applyHunks(doc, hunks, strict, oldP);
        tree.now.set(newP, docText(doc));
        tree.now.set(oldP, null);
        tree.moves.push([oldP, newP]);
      });
      continue;
    }
    edits.push((tree) => {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const text = tree.get(newP);
      if (text === null) throw new Fail('missing', newP);
      const doc = readDoc(text);
      applyHunks(doc, hunks, strict, newP);
      tree.now.set(newP, docText(doc));
    });
  }
  return edits;
}

// ---------- SEARCH/REPLACE blocks (section 7) ----------

const SEARCH_MARK = '<<<<<<< SEARCH';
const EQUALS_MARK = '=======';
const REPLACE_MARK = '>>>>>>> REPLACE';

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== SEARCH_MARK) {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let eq = -1;
    for (let k = searchLine + 1; k < n; k += 1) {
      const t = lines[k]!.trimEnd();
      if (t === EQUALS_MARK) {
        eq = k;
        break;
      }
      if (t === REPLACE_MARK) break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let end = -1;
    for (let k = eq + 1; k < n; k += 1) {
      if (lines[k]!.trimEnd() === REPLACE_MARK) {
        end = k;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, end);
    const target = path;
    edits.push((tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      if (oldLines.length === 0) {
        if (tree.get(target) !== null) throw new Fail('exists', target);
        tree.now.set(target, createdText(newLines, false));
        return;
      }
      const text = tree.get(target);
      if (text === null) throw new Fail('missing', target);
      const doc = readDoc(text);
      const found = tierOf(doc.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', target);
      if (found.positions.length > 1) throw new Fail('ambiguous', target);
      const body: BodyLine[] = [];
      for (const t of oldLines) body.push({ kind: 'old', text: t, noEol: false });
      for (const t of newLines) body.push({ kind: 'new', text: t, noEol: false });
      applyBody(doc, found.positions[0]!, oldLines, body, found.tier);
      tree.now.set(target, docText(doc));
    });
    prevEnd = end + 1;
    prevPath = path;
    i = end + 1;
  }
  return edits;
}

// ---------- V4A patches (section 8) ----------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

const V_ADD = '*** Add File: ';
const V_DELETE = '*** Delete File: ';
const V_UPDATE = '*** Update File: ';
const V_MOVE = '*** Move to: ';

/** The first occurrence of O at or after `from`, at the first tier that has one. */
function tierOfFrom(fileLines: string[], o: string[], from: number, strict: boolean, eof: boolean): { tier: number; pos: number } | null {
  const max = strict ? 0 : 2;
  for (let tier = 0; tier <= max; tier += 1) {
    for (let i = from; i + o.length <= fileLines.length; i += 1) {
      if (eof && i + o.length !== fileLines.length) continue;
      let ok = true;
      for (let j = 0; j < o.length; j += 1) {
        if (!eqLine(tier, fileLines[i + j]!, o[j]!)) {
          ok = false;
          break;
        }
      }
      if (ok) return { tier, pos: i };
    }
  }
  return null;
}

const isVSection = (l: string): boolean => l.startsWith(V_ADD) || l.startsWith(V_DELETE) || l.startsWith(V_UPDATE);
const bodyKind = (l: string): BodyKind | null => {
  if (l === '') return 'ctx';
  const c = l[0];
  return c === ' ' ? 'ctx' : c === '-' ? 'old' : c === '+' ? 'new' : null;
};

function applyChunks(doc: Doc, chunks: VChunk[], strict: boolean, path: string): void {
  let cursor = 0;
  const maxTier = strict ? 0 : 2;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      let at = -1;
      for (let tier = 0; tier <= maxTier && at < 0; tier += 1) {
        for (let p = cursor; p < doc.lines.length; p += 1) {
          if (eqLine(tier, doc.lines[p]!, ch.anchor)) {
            at = p;
            break;
          }
        }
      }
      if (at < 0) throw new Fail('no-match', path);
      cursor = at + 1;
    }
    const o = oOf(ch.body);
    let pos: number;
    let tier = 0;
    if (o.length > 0) {
      const found = tierOfFrom(doc.lines, o, cursor, strict, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      tier = found.tier;
      pos = found.pos;
    } else {
      pos = ch.eof ? doc.lines.length : Math.min(cursor, doc.lines.length);
    }
    applyBody(doc, pos, o, ch.body, tier);
    cursor = pos + nLen(ch.body);
  }
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = n - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const head = lines[i]!;
    if (blank(head)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (head.startsWith(V_ADD)) {
      kind = 'add';
      path = head.slice(V_ADD.length).trim();
    } else if (head.startsWith(V_DELETE)) {
      kind = 'delete';
      path = head.slice(V_DELETE.length).trim();
    } else if (head.startsWith(V_UPDATE)) {
      kind = 'update';
      path = head.slice(V_UPDATE.length).trim();
    } else throw new Exit2(`error: parse ${i + 1}`);
    const headLine = i;
    let j = i + 1;
    while (j < last && !isVSection(lines[j]!)) j += 1;
    let end = j;
    while (end > i + 1 && blank(lines[end - 1]!)) end -= 1;
    if (kind === 'add') {
      const out: string[] = [];
      for (let k = i + 1; k < end; k += 1) {
        const t = lines[k]!;
        if (t === '') out.push('');
        else if (t.startsWith('+')) out.push(t.slice(1));
        else throw new Exit2(`error: parse ${k + 1}`);
      }
      const target = path;
      edits.push((tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) !== null) throw new Fail('exists', target);
        tree.now.set(target, createdText(out, false));
      });
    } else if (kind === 'delete') {
      for (let k = i + 1; k < end; k += 1) throw new Exit2(`error: parse ${k + 1}`);
      const target = path;
      edits.push((tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) === null) throw new Fail('missing', target);
        tree.now.set(target, null);
      });
    } else {
      let k = i + 1;
      let moveTo: string | null = null;
      if (k < end && lines[k]!.startsWith(V_MOVE)) {
        moveTo = lines[k]!.slice(V_MOVE.length).trim();
        k += 1;
      }
      const chunks: VChunk[] = [];
      while (k < end) {
        let anchor: string | null = null;
        if (lines[k]!.startsWith('@@')) {
          const a = lines[k]!.slice(2).trim();
          anchor = a === '' ? null : a;
          k += 1;
        } else if (chunks.length > 0) {
          throw new Exit2(`error: parse ${k + 1}`);
        }
        const body: BodyLine[] = [];
        let eof = false;
        while (k < end) {
          const t = lines[k]!;
          if (t.startsWith('@@')) break;
          if (t === '*** End of File') {
            eof = true;
            k += 1;
            break;
          }
          const bk = bodyKind(t);
          if (bk === null) throw new Exit2(`error: parse ${k + 1}`);
          body.push({ kind: bk, text: bk === 'ctx' && t === '' ? '' : t.slice(1), noEol: false });
          k += 1;
        }
        chunks.push({ anchor, eof, body });
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headLine + 1}`);
      const oldPath = path;
      const newPath = moveTo;
      edits.push((tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        const target = newPath ?? oldPath;
        if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
        const text = tree.get(oldPath);
        if (text === null) throw new Fail('missing', oldPath);
        if (newPath !== null && tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const doc = readDoc(text);
        applyChunks(doc, chunks, strict, oldPath);
        tree.now.set(target, docText(doc));
        if (newPath !== null) {
          tree.now.set(oldPath, null);
          tree.moves.push([oldPath, newPath]);
        }
      });
    }
    i = end;
  }
  return edits;
}

// ---------- JSON edits (section 9) ----------

/** One JSON edit object, or null when it is not one. */
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

// ---------- format detection (section 4) ----------

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

// ---------- the command line, the output and the write (sections 1, 2 and 10) ----------

const byPath = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

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
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else if (kind === 'v4a') edits = parseV4a(lines, strict);
    else edits = [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const state = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    state.set(p, { was, now });
  }
  const rows: { key: string; line: string }[] = [];
  const taken = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (taken.has(oldP) || taken.has(newP)) continue;
    const a = state.get(oldP);
    const b = state.get(newP);
    if (a === undefined || b === undefined) continue;
    if (a.was === null || a.now !== null || b.was !== null || b.now === null) continue;
    rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    taken.add(oldP);
    taken.add(newP);
  }
  for (const [p, s] of state) {
    if (taken.has(p)) continue;
    const code = s.was === null ? 'A' : s.now === null ? 'D' : 'M';
    rows.push({ key: p, line: `${code} ${p}` });
  }
  rows.sort((x, y) => byPath(x.key, y.key));
  if (!check) {
    for (const p of [...state.keys()].sort(byPath)) {
      const s = state.get(p)!;
      if (s.now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, s.now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
