/**
 * Switch zod to its interpreted validators. Import this module before anything that defines a schema.
 *
 * Why: zod compiles object validators with `new Function` when it can, and probes for that with an
 * eval when each schema is defined. Under our CSP (no 'unsafe-eval') that probe is blocked and
 * reported as a violation on every page load. The interpreted path is just as correct and plenty
 * fast for form-sized schemas. It must run first because the schemas (the generated ones included)
 * read the setting when they are created, which is at import time, not when they first parse.
 */
import { z } from 'zod';

z.config({ jitless: true });
