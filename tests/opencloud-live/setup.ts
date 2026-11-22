import { DOMParser } from '@xmldom/xmldom';
import { setContentDigest } from '../../src/util/hash';

// Same polyfills as upstream's b1 setup: no DOMParser in the jest node environment, and source uses window.setTimeout.
(globalThis as unknown as { DOMParser: unknown }).DOMParser = DOMParser;
(globalThis as unknown as { window: typeof globalThis }).window = globalThis;

// The fork's engine digest, exactly as main.ts sets it at load.
setContentDigest('SHA-1');

// TLS: compose.yml serves plain HTTP. For an https:// server, run.sh trusts its certificate through NODE_EXTRA_CA_CERTS
// before jest starts; certificate checking itself stays on.
