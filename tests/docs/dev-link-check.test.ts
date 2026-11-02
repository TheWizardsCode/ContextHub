/**
 * Doc-link resolution tests (WL-0MVZ4I4QR000C1UG)
 *
 * Every relative Markdown file link in `docs/dev/*.md` and the root
 * `AGENTS.md` must resolve to an existing path on disk, resolved relative to
 * the linking file. A commit that reintroduces a dangling link therefore fails
 * the default suite instead of sending an agent to a non-existent page.
 *
 * Exclusions are deliberate and by kind only:
 *   - `http://`, `https://` and any other `scheme:` target (e.g. `mailto:`) is
 *     an external reference, never a file target;
 *   - an in-file anchor (`#section`) targets the current document;
 *   - protocol-relative `//host/path` targets are external too.
 *
 * Everything else is treated as a file target. A trailing `#fragment` is
 * stripped before resolution (the file must still exist). Absolute file paths
 * (`/home/.../file.md`) are accepted when the file exists and fail when it does
 * not — that is what catches the "valid only inside another checkout"
 * regression.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

const DOCS_DEV_DIR = path.join(REPO_ROOT, 'docs', 'dev');
const ROOT_AGENTS_MD = path.join(REPO_ROOT, 'AGENTS.md');

/** An inline Markdown link or image: `[text](target)` / `![alt](target)`. */
const INLINE_LINK_RE = /!?\[[^\]]*\]\(([^)]+)\)/g;

export interface DiscoveredLink {
  /** 1-based line number of the link inside its source file. */
  line: number;
  /** The raw target exactly as written in the document. */
  rawTarget: string;
}

export interface DanglingLink {
  /** Absolute path of the document that contains the link. */
  source: string;
  line: number;
  rawTarget: string;
  /** Absolute path the link was resolved against (empty when not a file). */
  resolved: string;
  reason: string;
}

/**
 * Strip an optional Markdown link title and angle brackets:
 *   `foo.md "Title"` → `foo.md`
 *   `<foo bar.md>`   → `foo bar.md`
 */
export function normaliseTarget(rawTarget: string): string {
  const trimmed = rawTarget.trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    return trimmed.slice(1, -1).trim();
  }
  // Everything after the first run of whitespace is a title, not the target.
  return trimmed.split(/\s+/)[0] ?? '';
}

/** True when a link target names an external scheme rather than a file. */
export function isExternalTarget(target: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith('//');
}

/** True when a link target is an in-file anchor (`#section`). */
export function isAnchorOnlyTarget(target: string): boolean {
  return target.startsWith('#');
}

/** Remove a `#fragment` from a file target, keeping the file path. */
export function stripFragment(target: string): string {
  const hashIndex = target.indexOf('#');
  return hashIndex === -1 ? target : target.slice(0, hashIndex);
}

/**
 * Extract every inline link target from a document, with its line number.
 * Reference-style link definitions (`[id]: target`) are intentionally out of
 * scope: the docs use inline links only.
 */
export function extractLinks(content: string): DiscoveredLink[] {
  const links: DiscoveredLink[] = [];
  const lineStarts: number[] = [0];
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === '\n') lineStarts.push(i + 1);
  }

  const lineOf = (offset: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (lineStarts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };

  for (const match of content.matchAll(INLINE_LINK_RE)) {
    const rawTarget = match[1];
    if (rawTarget === undefined) continue;
    links.push({ line: lineOf(match.index ?? 0), rawTarget });
  }
  return links;
}

/**
 * Check one document. Returns a violation per file target that does not
 * resolve. External schemes and in-file anchors are skipped by kind.
 */
export function checkDocument(sourcePath: string): DanglingLink[] {
  const content = fs.readFileSync(sourcePath, 'utf-8');
  const sourceDir = path.dirname(sourcePath);
  const violations: DanglingLink[] = [];

  for (const { line, rawTarget } of extractLinks(content)) {
    const target = normaliseTarget(rawTarget);
    if (target === '' || isAnchorOnlyTarget(target) || isExternalTarget(target)) {
      continue;
    }

    const fileTarget = stripFragment(target);
    if (fileTarget === '') continue;

    const resolved = path.isAbsolute(fileTarget)
      ? fileTarget
      : path.resolve(sourceDir, fileTarget);

    if (!fs.existsSync(resolved)) {
      violations.push({
        source: sourcePath,
        line,
        rawTarget,
        resolved,
        reason: path.isAbsolute(fileTarget)
          ? 'absolute path does not exist'
          : 'relative path does not resolve',
      });
    }
  }

  return violations;
}

/**
 * Collect the documents under check from the real on-disk tree — never a
 * hard-coded list. Throws (rather than skipping) when `docs/dev` or the root
 * `AGENTS.md` is missing or empty, so the check cannot silently pass by
 * discovering nothing.
 */
export function collectDocuments(repoRoot: string): string[] {
  const docsDevDir = path.join(repoRoot, 'docs', 'dev');
  const rootAgentsMd = path.join(repoRoot, 'AGENTS.md');

  if (!fs.existsSync(docsDevDir) || !fs.statSync(docsDevDir).isDirectory()) {
    throw new Error(`Missing docs/dev directory: ${docsDevDir}`);
  }
  const docs = fs
    .readdirSync(docsDevDir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => path.join(docsDevDir, name));

  if (docs.length === 0) {
    throw new Error(`No Markdown documents found in ${docsDevDir}`);
  }
  if (!fs.existsSync(rootAgentsMd)) {
    throw new Error(`Missing root AGENTS.md: ${rootAgentsMd}`);
  }

  return [...docs, rootAgentsMd];
}

/** Check every document under the repository's standard doc set. */
export function checkRepository(repoRoot: string): DanglingLink[] {
  return collectDocuments(repoRoot).flatMap((doc) => checkDocument(doc));
}

// ---------------------------------------------------------------------------
// Self-tests: the checker itself must detect dangling links, otherwise a green
// repository check would be meaningless (probe-regression proof).
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function makeTempTree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-link-check-'));
  tempDirs.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
  }
  return root;
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('doc-link checker classification', () => {
  it('accepts relative, fragment and directory links that exist', () => {
    const root = makeTempTree({
      'docs/dev/guide.md': [
        '[sibling](./other.md)',
        '[without dot prefix](other.md)',
        '[fragment](#local-section)',
        '[file fragment](./other.md#some-section)',
        '[parent](../../README.md)',
        '[directory](../)',
        '[titled](./other.md "A title")',
        '[angle bracket](<./other.md>)',
      ].join('\n'),
      'docs/dev/other.md': '# Other\n',
      'README.md': '# Root\n',
    });

    expect(checkDocument(path.join(root, 'docs', 'dev', 'guide.md'))).toEqual([]);
  });

  it('skips external schemes and protocol-relative targets by kind', () => {
    const root = makeTempTree({
      'docs/dev/external.md': [
        '[web](https://example.com/page.md)',
        '[insecure](http://example.com/page.md)',
        '[mail](mailto:someone@example.com)',
        '[protocol relative](//example.com/page.md)',
      ].join('\n'),
    });

    expect(checkDocument(path.join(root, 'docs', 'dev', 'external.md'))).toEqual([]);
  });

  it('reports a dangling relative link with file, line and target', () => {
    const root = makeTempTree({
      'docs/dev/broken.md': ['# Broken', '', '[missing](./nowhere.md)'].join('\n'),
    });

    const violations = checkDocument(path.join(root, 'docs', 'dev', 'broken.md'));

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      line: 3,
      rawTarget: './nowhere.md',
      reason: 'relative path does not resolve',
    });
    expect(violations[0].resolved).toBe(
      path.join(root, 'docs', 'dev', 'nowhere.md'),
    );
  });

  it('accepts an existing absolute path and rejects a missing one', () => {
    const root = makeTempTree({ 'docs/dev/present.md': '# Present\n' });
    const absoluteFile = path.join(root, 'docs', 'dev', 'present.md');
    const missingFile = path.join(root, 'docs', 'dev', 'absent.md');
    const docPath = path.join(root, 'docs', 'dev', 'absolute.md');
    fs.writeFileSync(
      docPath,
      `[present](${absoluteFile})\n[absent](${missingFile})`,
      'utf-8',
    );

    const violations = checkDocument(docPath);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      rawTarget: missingFile,
      reason: 'absolute path does not exist',
    });
  });

  it('fails loudly when docs/dev or AGENTS.md is missing', () => {
    const root = makeTempTree({ 'README.md': '# Root\n' });

    expect(() => collectDocuments(root)).toThrow(/Missing docs\/dev directory/);

    fs.mkdirSync(path.join(root, 'docs', 'dev'), { recursive: true });
    expect(() => collectDocuments(root)).toThrow(/No Markdown documents found/);

    fs.writeFileSync(path.join(root, 'docs', 'dev', 'page.md'), '# Page\n', 'utf-8');
    expect(() => collectDocuments(root)).toThrow(/Missing root AGENTS\.md/);
  });
});

// ---------------------------------------------------------------------------
// The real repository check.
// ---------------------------------------------------------------------------

describe('docs/dev and AGENTS.md link resolution', () => {
  it('discovers the documents from disk (no hard-coded list)', () => {
    const documents = collectDocuments(REPO_ROOT);
    const docsDevFiles = documents.filter(
      (doc) => path.dirname(doc) === DOCS_DEV_DIR,
    );

    expect(docsDevFiles.length).toBeGreaterThan(0);
    expect(docsDevFiles.every((doc) => doc.endsWith('.md'))).toBe(true);
    // Every docs/dev document plus the root AGENTS.md — nothing else.
    expect(documents).toHaveLength(docsDevFiles.length + 1);
    expect(documents[documents.length - 1]).toBe(ROOT_AGENTS_MD);
  });

  it('has no dangling links in docs/dev/*.md and AGENTS.md', () => {
    const documents = collectDocuments(REPO_ROOT);
    const totalLinks = documents.reduce(
      (count, doc) => count + extractLinks(fs.readFileSync(doc, 'utf-8')).length,
      0,
    );
    // Guard against a link parser that silently stops matching anything.
    expect(totalLinks).toBeGreaterThan(0);

    const violations = checkRepository(REPO_ROOT).map((violation) => {
      const relativeSource = path.relative(REPO_ROOT, violation.source);
      return `${relativeSource}:${violation.line}: ${violation.rawTarget} (${violation.reason})`;
    });

    expect(violations).toEqual([]);
  });
});
