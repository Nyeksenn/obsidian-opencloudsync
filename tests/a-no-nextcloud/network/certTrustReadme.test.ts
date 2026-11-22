import { readFileSync } from 'fs';
import { join } from 'path';
import { CERT_TRUST_FAQ_TITLE } from '../../../src/network/certTrust';

// [opencloud-fork] README.md only: the Japanese README was removed. The English assertions are upstream's, unchanged.
// The READMEs must explain the untrusted-server-certificate problem before a user hits it (docs/spec.md §11.3): the
// symptom, the cause, what works on which platform, how to fix it, and that verification cannot be switched off.
// Japanese strings are written as escapes so this file stays free of CJK.

const root = join(__dirname, '..', '..', '..');
const en = readFileSync(join(root, 'README.md'), 'utf-8');

// From the heading line to the next level-2 heading (or the end of the file).
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = text.indexOf('\n## ', start + heading.length + 2);
  return next === -1 ? text.slice(start) : text.slice(start, next);
}

// The FAQ entry about the certificate: from its bold question line to the next horizontal rule.
function faqEntry(text: string): string {
  const lines = section(text, '## FAQ').split('\n');
  const first = lines.findIndex((line) => line.startsWith('**') && line.includes(CERT_TRUST_FAQ_TITLE));
  expect(first).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(first).join('\n');
  const end = rest.indexOf('\n---\n');
  return end === -1 ? rest : rest.slice(0, end);
}

const EN_REQUIRED = [
  CERT_TRUST_FAQ_TITLE,
  // (a) the symptom, as the user sees it
  'Trust anchor for certification path not found',
  'SSLHandshakeException',
  'CertPathValidatorException',
  'net::ERR_CERT_AUTHORITY_INVALID',
  // (b) the cause
  'requestUrl',
  'cannot be fixed from the plugin settings',
  // (c) what works where
  'Android',
  'publicly trusted certificate',
  'Linux',
  'certutil',
  '~/.pki/nssdb',
  'Windows',
  'macOS',
  'iOS',
  'not verified',
  // (d) how to fix it
  'Let\'s Encrypt',
  'DNS-01',
  'full certificate chain',
  'VPN',
  'A VPN alone does not fix this',
  // (e) verification cannot be switched off
  'There is no way to turn off certificate verification',
];


const EN_QUESTION =
  '**Server certificate not trusted (`Trust anchor for certification path not found` / `net::ERR_CERT_AUTHORITY_INVALID`) — can I use a self-signed or private-CA certificate?**';

describe('[SPEC:CTE-6] the READMEs explain the untrusted server certificate', () => {
  it.each(EN_REQUIRED)('README.md FAQ entry contains: %s', (needle) => {
    expect(faqEntry(en)).toContain(needle);
  });


  it('README.md states the question in the fixed wording', () => {
    expect(faqEntry(en)).toContain(EN_QUESTION);
  });


  it('README.md Requirements points to the FAQ entry', () => {
    expect(section(en, '## Requirements')).toContain(CERT_TRUST_FAQ_TITLE);
  });

});
