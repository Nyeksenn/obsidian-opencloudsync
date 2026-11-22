// [opencloud-fork] The Obsidian community directory's submission rules that can be checked from the repository
// (docs.obsidian.md, "Submission requirements for plugins" and "Developer policies").
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '..', '..', '..');
const read = (f: string): string => readFileSync(join(root, f), 'utf-8');
const manifest = JSON.parse(read('manifest.json')) as Record<string, unknown>;
const versions = JSON.parse(read('versions.json')) as Record<string, string>;
const pkg = JSON.parse(read('package.json')) as { version: string };
const readme = read('README.md');

describe('community directory submission requirements', () => {
  it('has README.md, LICENSE and manifest.json at the repository root', () => {
    for (const f of ['README.md', 'LICENSE', 'manifest.json']) expect(existsSync(join(root, f))).toBe(true);
  });

  it('uses an id without "obsidian" and a name without "Obsidian"', () => {
    expect(manifest.id).toMatch(/^[a-z0-9-]+$/);
    expect(String(manifest.id)).not.toMatch(/obsidian/i);
    expect(String(manifest.name)).not.toMatch(/obsidian/i);
  });

  it('versions the release as plain x.y.z, consistently across manifest, versions.json and package.json', () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(versions[String(manifest.version)]).toBe(manifest.minAppVersion);
    expect(pkg.version).toBe(manifest.version);
  });

  it('keeps the description short, plain and ending with a period', () => {
    const d = String(manifest.description);
    expect(d.length).toBeLessThanOrEqual(250);
    expect(d.endsWith('.')).toBe(true);
    expect(d).not.toMatch(/^this is a plugin/i);
    expect(d).not.toMatch(/obsidian/i);
    // No emoji or other special characters.
    expect(d).toMatch(/^[A-Za-z0-9 ,.;:'()-]+$/);
  });

  it('declares no funding URL (the project accepts no donations)', () => {
    expect(manifest.fundingUrl).toBeUndefined();
  });

  it('runs on mobile: no Node.js or Electron APIs in the source', () => {
    expect(manifest.isDesktopOnly).toBe(false);
    // Any import of a Node built-in or Electron anywhere in src/ would break mobile.
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(join(root, 'src'));
    const nodeImport = /(from\s+|require\()['"](node:)?(fs|path|os|crypto|child_process|electron|http|https|net)['"]/;
    expect(files.filter((f) => nodeImport.test(readFileSync(f, 'utf-8')))).toEqual([]);
  });

  it('discloses account requirement and network use in the README', () => {
    expect(readme).toContain('## Privacy and network use');
    expect(readme).toMatch(/Account required/);
    expect(readme).toMatch(/Network use/);
    expect(readme).toMatch(/No telemetry/);
  });
});
