// [opencloud-fork] Every package compiled into main.js must have its license text in THIRD_PARTY_NOTICES.md, which the
// build embeds into main.js. An upstream merge that adds a runtime dependency fails here instead of shipping without notice.
import { readFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';

const root = join(__dirname, '..', '..', '..');
const notices = readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf-8');

// The bundle is analysed in a separate Node process: esbuild keeps a service running in the calling process, and other
// suites in the same jest worker replace TextDecoder.prototype.decode, which then breaks that lingering service.
// Same externals as esbuild.config.mjs: provided by Obsidian at runtime, not shipped.
const ANALYSE = `
const esbuild = require('esbuild');
const { builtinModules } = require('module');
esbuild.build({
  entryPoints: ['src/main.ts'], bundle: true, write: false, metafile: true, format: 'cjs', target: 'es2018', logLevel: 'silent',
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*', ...builtinModules, ...builtinModules.map((m) => 'node:' + m)],
  outfile: 'out.js',
}).then((r) => { process.stdout.write(JSON.stringify(Object.keys(r.metafile.outputs['out.js'].inputs))); });
`;

function bundledPackages(): string[] {
  const inputs = JSON.parse(execFileSync(process.execPath, ['-e', ANALYSE], { cwd: root, encoding: 'utf-8' })) as string[];
  const packages = new Set<string>();
  for (const input of inputs) {
    const m = input.match(/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/);
    if (m) packages.add(m[1]);
  }
  return [...packages].sort();
}

describe('third-party notices', () => {
  it('lists every package bundled into main.js', () => {
    const packages = bundledPackages();
    expect(packages.length).toBeGreaterThan(0);
    expect(packages.filter((p) => !notices.includes(`\n## ${p}\n`))).toEqual([]);
  }, 60000);

  it('holds a full license text for each listed component', () => {
    const sections = notices.split('\n## ').slice(1);
    expect(sections.length).toBeGreaterThanOrEqual(3);
    for (const s of sections) {
      expect(s).toMatch(/Permission is hereby granted|Permission to use, copy, modify/);
    }
  });

  it('is embedded into main.js by the build, together with the plugin license', () => {
    const config = readFileSync(join(root, 'esbuild.config.mjs'), 'utf-8');
    expect(config).toContain('"LICENSE", "THIRD_PARTY_NOTICES.md"');
  });
});
