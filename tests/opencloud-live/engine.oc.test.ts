// Upstream's unchanged SyncEngine over OpenCloud: two devices, one folder in a live space. These are the behaviours the
// fork must not regress — round-trip, no redundant transfers (the SHA-1 digest), conflict handling, renames, deletions.
import { makeDevice, Device } from './support/device';
import { ocEnv, uniqueFolder } from './support/env';

const env = ocEnv();

async function pair(label: string): Promise<{ a: Device; b: Device; folder: string }> {
  const folder = uniqueFolder(label);
  const a = makeDevice(env, folder, `device-a-${label}`);
  const b = makeDevice(env, folder, `device-b-${label}`);
  // The sync folder is created by the first device to sync (createVaultRoot), as in production.
  return { a, b, folder };
}

describe('SyncEngine over OpenCloud (live)', () => {
  it('round-trips files between devices and a re-sync transfers nothing', async () => {
    const { a, b } = await pair('roundtrip');
    a.vault.seedLocal('note.md', '# Hello\n\nfrom A\n');
    a.vault.seedLocal('folder/deep/inner.md', 'inner\n');
    a.vault.seedLocal('attachments/pic.bin', 'binary-ish \u0000 content');
    await a.sync();
    expect(a.counts.uploads).toBe(3);

    await b.sync();
    expect(b.vault.readLocal('note.md')).toBe('# Hello\n\nfrom A\n');
    expect(b.vault.readLocal('folder/deep/inner.md')).toBe('inner\n');
    expect(b.counts.downloads).toBe(3);

    // The decisive check for the SHA-1 digest: if the engine's content hash did not match the server's checksum, an
    // unchanged file would look changed and be transferred again.
    a.resetCounts(); b.resetCounts();
    await a.sync();
    await b.sync();
    expect(a.counts).toEqual({ uploads: 0, downloads: 0, deletes: 0, moves: 0 });
    expect(b.counts).toEqual({ uploads: 0, downloads: 0, deletes: 0, moves: 0 });
  });

  it('propagates an edit, then a delete, from one device to the other', async () => {
    const { a, b } = await pair('edit-delete');
    a.vault.seedLocal('doc.md', 'v1\n');
    await a.sync();
    await b.sync();

    b.vault.seedLocal('doc.md', 'v2 from B\n');
    await b.sync();
    a.resetCounts();
    await a.sync();
    expect(a.vault.readLocal('doc.md')).toBe('v2 from B\n');
    expect(a.counts.downloads).toBe(1);

    a.vault.deleteLocalTree('doc.md');
    await a.sync();
    expect(await a.client.remoteExists('doc.md')).toBe(false);
    await b.sync();
    expect(b.vault.localExists('doc.md')).toBe(false);
  });

  it('merges non-overlapping concurrent edits to the same note', async () => {
    const { a, b } = await pair('merge');
    const base = 'line 1\nline 2\nline 3\nline 4\nline 5\n';
    a.vault.seedLocal('shared.md', base);
    await a.sync();
    await b.sync();

    a.vault.seedLocal('shared.md', 'line 1 edited by A\nline 2\nline 3\nline 4\nline 5\n');
    b.vault.seedLocal('shared.md', 'line 1\nline 2\nline 3\nline 4\nline 5 edited by B\n');
    await a.sync();
    await b.sync(); // B sees a remote change and a local change: 3-way merge against the recorded base
    await a.sync();

    // Both edits survive and both devices converge on identical bytes. Trailing whitespace is not asserted: upstream's
    // MergeEngine.merge itself appends one blank line for this input (reproducible without any server), which is
    // upstream behaviour, not something this fork changes.
    const onA = a.vault.readLocal('shared.md')!;
    const onB = b.vault.readLocal('shared.md')!;
    expect(onB.trimEnd()).toBe('line 1 edited by A\nline 2\nline 3\nline 4\nline 5 edited by B');
    expect(onA).toBe(onB);
  });

  it('keeps both sides of a same-line conflict instead of losing one', async () => {
    const { a, b } = await pair('conflict');
    a.vault.seedLocal('c.md', 'title\nthe same line\nend\n');
    await a.sync();
    await b.sync();

    a.vault.seedLocal('c.md', 'title\nA says this\nend\n');
    b.vault.seedLocal('c.md', 'title\nB says that\nend\n');
    await a.sync();
    await b.sync();

    const onB = b.vault.readLocal('c.md')!;
    expect(onB).toContain('A says this');
    expect(onB).toContain('B says that');
  });

  it('propagates a folder rename', async () => {
    const { a, b } = await pair('rename');
    a.vault.seedLocal('projects/alpha/plan.md', 'plan\n');
    a.vault.seedLocal('projects/alpha/notes.md', 'notes\n');
    await a.sync();
    await b.sync();

    const plan = a.vault.readLocal('projects/alpha/plan.md')!;
    const notes = a.vault.readLocal('projects/alpha/notes.md')!;
    a.vault.deleteLocalTree('projects/alpha');
    a.vault.seedLocal('projects/beta/plan.md', plan);
    a.vault.seedLocal('projects/beta/notes.md', notes);
    await a.sync();
    await b.sync();

    expect(b.vault.readLocal('projects/beta/plan.md')).toBe('plan\n');
    expect(b.vault.readLocal('projects/beta/notes.md')).toBe('notes\n');
    expect(b.vault.localExists('projects/alpha/plan.md')).toBe(false);
  });

  it('skips the full listing when nothing changed on the server (root-ETag short-circuit)', async () => {
    const { a } = await pair('etag-skip');
    a.vault.seedLocal('x/y/z.md', 'z\n');
    await a.sync();
    await a.sync(); // records the root ETag from a real scan
    const before = a.stateDB.getFullScanSkipCount();
    await a.sync();
    expect(a.stateDB.getFullScanSkipCount()).toBe(before + 1);
  });
});
