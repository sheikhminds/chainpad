// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import {
  SCHEMA_VERSION,
  SHARE_HASH_PREFIX,
  TEMPLATES,
  clearProject,
  defaultProject,
  encodeProjectHash,
  loadProject,
  parseProject,
  projectFromHash,
  saveProject,
  serializeProject,
} from '../src/lib/project.ts';

afterEach(() => {
  clearProject();
});

describe('project model', () => {
  it('ships four templates, each with a test file', () => {
    expect(TEMPLATES.map((template) => template.id)).toEqual(['counter', 'erc20', 'voting', 'nft']);
    for (const template of TEMPLATES) {
      const project = template.project();
      expect(project.files.length).toBeGreaterThan(0);
      expect(project.tests).toContain("test('");
      expect(project.settings.compiler).toMatch(/^0\.\d+\.\d+$/);
    }
  });

  it('uses the counter template by default', () => {
    expect(defaultProject().name).toBe('Counter');
  });

  it('round-trips through export and import', () => {
    for (const template of TEMPLATES) {
      const project = template.project();
      const parsed = parseProject(serializeProject(project));
      expect(parsed).toEqual(project);
      const exported = JSON.parse(serializeProject(project)) as { schemaVersion: number };
      expect(exported.schemaVersion).toBe(SCHEMA_VERSION);
    }
  });

  it('accepts a bare project object without the wrapper', () => {
    const project = defaultProject();
    expect(parseProject(JSON.stringify(project))).toEqual(project);
  });

  it('normalizes missing or invalid optional fields', () => {
    const parsed = parseProject(
      JSON.stringify({
        name: '  ',
        files: [{ name: ' A.sol ', content: 'contract A {}' }],
        activeFile: 'missing.sol',
        settings: { compiler: '', optimizer: 'yes', runs: -10 },
      }),
    );
    expect(parsed.name).toBe('Untitled');
    expect(parsed.files[0].name).toBe('A.sol');
    expect(parsed.activeFile).toBe('A.sol');
    expect(parsed.settings).toEqual({ compiler: '0.8.30', optimizer: true, runs: 1 });
    expect(parsed.tests).toBe('');
  });

  it('rejects malformed projects with readable errors', () => {
    expect(() => parseProject('not json')).toThrow('not valid JSON');
    expect(() => parseProject('{}')).toThrow('at least one file');
    expect(() => parseProject('{"files":[]}')).toThrow('at least one file');
    expect(() => parseProject('{"files":[{"name":"","content":""}]}')).toThrow('empty name');
    expect(() => parseProject('{"files":[{"name":"A.sol","content":""},{"name":"A.sol","content":""}]}')).toThrow(
      'Duplicate file name',
    );
  });

  it('saves and loads from localStorage', () => {
    const project = TEMPLATES[1].project();
    project.name = 'Saved token';
    saveProject(project);
    expect(loadProject()).toEqual(project);
  });

  it('falls back to the default project when storage is corrupt', () => {
    localStorage.setItem('chainpad:project:v1', '{not json');
    expect(loadProject().name).toBe('Counter');
  });
});

describe('share links', () => {
  it('round-trips a project through the URL fragment', () => {
    const project = TEMPLATES[2].project();
    project.name = 'Shared voting';
    const hash = encodeProjectHash(project);
    expect(hash.startsWith(SHARE_HASH_PREFIX)).toBe(true);
    // URL-safe: no +, / or = that would need escaping.
    expect(hash.slice(SHARE_HASH_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(projectFromHash(hash)).toEqual(project);
  });

  it('accepts the fragment with or without the leading #', () => {
    const project = defaultProject();
    const hash = encodeProjectHash(project);
    expect(projectFromHash(hash.slice(1))).toEqual(project);
  });

  it('survives non-ASCII source in comments', () => {
    const project = defaultProject();
    project.files[0].content = `// পটভূমি — ünïcode ✓\npragma solidity ^0.8.20;\ncontract Counter {}`;
    expect(projectFromHash(encodeProjectHash(project))?.files[0].content).toBe(
      project.files[0].content,
    );
  });

  it('returns null for a missing, malformed or unrelated fragment', () => {
    expect(projectFromHash('')).toBeNull();
    expect(projectFromHash('#')).toBeNull();
    expect(projectFromHash('#section-2')).toBeNull();
    expect(projectFromHash('#p=')).toBeNull();
    expect(projectFromHash('#p=not-base64!!')).toBeNull();
    expect(projectFromHash(`#p=${btoa('{"files":')}`)).toBeNull();
  });

  it('refuses to build an unusable link for a huge project', () => {
    const project = defaultProject();
    project.files[0].content = `// ${'x'.repeat(20_000)}`;
    expect(() => encodeProjectHash(project)).toThrow(/too large for a share link/);
  });

  it('keeps the fragment free of the saved timestamp and schema wrapper', () => {
    const hash = encodeProjectHash(defaultProject());
    const decoded = atob(hash.slice(SHARE_HASH_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/'));
    expect(decoded.startsWith('{"name"')).toBe(true);
    expect(decoded).not.toContain('exportedAt');
    expect(decoded).not.toContain('schemaVersion');
  });
});
