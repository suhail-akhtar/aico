/**
 * What a client draws of a connector pack (ADR 0039 section 3): its status, what it would be
 * allowed to do, and the facts a person needs to decide whether to enable it. Types only; no
 * imports, no secrets. A pack holds no credential, so there is nothing here to redact.
 *
 * The status is derived by the engine from the pack's content hash and the person's approval
 * record, never stored by a client:
 *
 *   invalid          the files do not validate (the errors are listed)
 *   draft            valid, but its contract tests have not all passed for this content
 *   tests-passing    every declared operation passed its contract for this exact content
 *   enabled          a person approved exactly this content
 *   needs-approval   a person approved an earlier version; something was edited since
 *
 * Routes (gate in brackets, same meaning as in types.ts):
 *   GET   /api/connections/packs              { packs: ConnectorPackView[] }
 *   POST  /api/connections/pack-test {id}                [token]   runs the contract test on loopback -> ConnectorPackView
 *   POST  /api/connections/pack-enable {id, hash}        [person]  hash = the content the person saw; a mismatch is refused
 *   POST  /api/connections/pack-disable {id}             [person]
 *   POST  /api/connections/pack-connect {id, insecureHttp?} [person] makes the connection (then: token, test)
 *
 * @module shared/connections/packs
 */

export type PackStatus = 'invalid' | 'draft' | 'tests-passing' | 'enabled' | 'needs-approval';
export type PackEffectClass = 'read' | 'external' | 'destructive';

export interface PackOperationView {
  name: string;
  /** What the file says it is. */
  declared: PackEffectClass;
  /** What the operation, the tool and the HTTP method make it: the class actually applied is the stricter. */
  effective: PackEffectClass;
  /** `GET https://api.example.com/v1/issues`, or `MCP server/tool`. Shown on the review card. */
  does: string;
  /** The last contract test: passed, failed (with why), or not run for this content. */
  contract: 'passed' | 'failed' | 'untested';
  detail?: string;
  readOnlyPost?: boolean;
}

export interface ConnectorPackView {
  id: string;
  label: string;
  provider: string;
  baseUrl: string;
  /** The closed list of hosts the connector may contact. */
  hosts: string[];
  /** `Authorization: Bearer`, `Basic (user)`, or the header name. */
  auth: string;
  authHelp?: string;
  mcpServers: string[];
  status: PackStatus;
  /** One sentence for the status chip's tooltip. */
  statusDetail: string;
  /** The content digest an approval binds to; the first 12 characters are shown. */
  hash: string;
  errors: string[];
  warnings: string[];
  operations: PackOperationView[];
  /** The operations that pass (what the connection can do once enabled), as short phrases. */
  can: string[];
  testedAt?: string;
  enabledAt?: string;
  /** Connections made from this pack (ids). */
  connections: string[];
  /** The organisation's policy forbids connector packs (or this one). */
  blockedByPolicy?: string;
}
