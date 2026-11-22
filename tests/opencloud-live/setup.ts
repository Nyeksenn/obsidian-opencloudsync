import { DOMParser } from '@xmldom/xmldom';
import { setContentDigest } from '../../src/util/hash';

// Same polyfills as upstream's b1 setup: no DOMParser in the jest node environment, and source uses window.setTimeout.
(globalThis as unknown as { DOMParser: unknown }).DOMParser = DOMParser;
(globalThis as unknown as { window: typeof globalThis }).window = globalThis;

// The fork's engine digest, exactly as main.ts sets it at load.
setContentDigest('SHA-1');

// TLS: the dev server's self-signed certificate is trusted explicitly through NODE_EXTRA_CA_CERTS, which run.sh sets
// before jest starts. Certificate checking itself stays on.
