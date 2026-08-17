/**
 * Phase definitions per tier.
 * Pure data — no logic, no I/O.
 */

import type { Tier } from './state.js';

export type PhaseAgentType =
  | 'architect'
  | 'backend'
  | 'frontend'
  | 'qa'
  | 'tech-writer'
  | 'product-owner'
  | 'security-audit'
  | 'healer';

export type PhaseKind =
  | 'design'        // produces docs/specs (no code)
  | 'implementation' // Ralph Loop — iterates until tasks complete
  | 'testing'       // runs tests, fixes failures
  | 'validation'    // browser QA, performance, security scans
  | 'gate'          // PO validates quality — pass/fail
  | 'documentation'; // generates docs

export interface PhaseDefinition {
  /** Display name */
  name: string;
  /** Short description shown in status UI */
  description: string;
  /** Which sub-agent type runs this phase */
  agentType: PhaseAgentType;
  kind: PhaseKind;
  /** Artifacts this phase must produce (paths relative to .studio/) */
  outputs: string[];
  /** For implementation phases: max Ralph Loop iterations */
  maxIterations: number;
  /** Whether to run full validation stack after this phase */
  runValidationAfter: boolean;
  /** Whether to run the PO quality gate after this phase */
  runPoGateAfter: boolean;
  /** Timeout for sub-agent in ms (0 = unlimited) */
  timeoutMs: number;
  /** Optional: model override for this phase (enables per-phase model selection) */
  model?: string;
  /**
   * Optional: file paths (relative to project root) to read and include in the
   * phase prompt as policy/guidance context. E.g. ["docs/security-policy.md",
   * "docs/coding-standards.md"]. The agent receives the full content of these
   * files as directives it must follow strictly.
   */
  docs?: string[];
  /**
   * Optional: condition that must be true to run this phase. Evaluated as a
   * simple description the pipeline checks before executing. Examples:
   * "always" (default), "if-previous-succeeded", "if-feedback-empty".
   * Enables conditional pipeline flow without code changes.
   */
  condition?: string;
}

// ── Small tier — 5 phases ────────────────────────────────────────────────────

const SMALL_PHASES: PhaseDefinition[] = [
  {
    name: 'PRD & Architecture',
    description: 'Define requirements, architecture, and task graph',
    agentType: 'architect',
    kind: 'design',
    outputs: ['PRD.md', 'ARCHITECTURE.md', 'TASKS.md'],
    maxIterations: 1,
    runValidationAfter: false,
    runPoGateAfter: false,
    timeoutMs: 10 * 60 * 1000,  // 10 min
  },
  {
    name: 'Backend Implementation',
    description: 'Build server, API routes, database layer, authentication',
    agentType: 'backend',
    kind: 'implementation',
    outputs: [],
    maxIterations: 10,
    runValidationAfter: true,
    runPoGateAfter: false,
    timeoutMs: 30 * 60 * 1000,  // 30 min
  },
  {
    name: 'Frontend Implementation',
    description: 'Build UI components, pages, forms, and state management',
    agentType: 'frontend',
    kind: 'implementation',
    outputs: [],
    maxIterations: 10,
    runValidationAfter: true,
    runPoGateAfter: false,
    timeoutMs: 30 * 60 * 1000,
  },
  {
    name: 'QA & Fix Loop',
    description: 'Run full test suite, browser QA, fix all failures',
    agentType: 'qa',
    kind: 'testing',
    outputs: [],
    maxIterations: 5,
    runValidationAfter: true,
    runPoGateAfter: true,
    timeoutMs: 20 * 60 * 1000,
  },
  {
    name: 'Documentation',
    description: 'Write README, setup guide, and inline API docs',
    agentType: 'tech-writer',
    kind: 'documentation',
    outputs: ['README.md'],
    maxIterations: 1,
    runValidationAfter: false,
    runPoGateAfter: false,
    timeoutMs: 10 * 60 * 1000,
  },
];

// ── Medium tier — 8 phases ───────────────────────────────────────────────────

const MEDIUM_PHASES: PhaseDefinition[] = [
  {
    name: 'PRD & User Stories',
    description: 'Research, define PRD, write detailed user stories with acceptance criteria',
    agentType: 'product-owner',
    kind: 'design',
    outputs: ['PRD.md', 'user-stories.md'],
    maxIterations: 1,
    runValidationAfter: false,
    runPoGateAfter: false,
    timeoutMs: 12 * 60 * 1000,
  },
  {
    name: 'Architecture & Task Graph',
    description: 'System design, API spec, ERD, dependency-annotated task graph',
    agentType: 'architect',
    kind: 'design',
    outputs: ['ARCHITECTURE.md', 'api-spec.yaml', 'TASKS.md'],
    maxIterations: 1,
    runValidationAfter: false,
    runPoGateAfter: false,
    timeoutMs: 12 * 60 * 1000,
  },
  {
    name: 'Backend Implementation',
    description: 'API, database, authentication, business logic, unit tests',
    agentType: 'backend',
    kind: 'implementation',
    outputs: [],
    maxIterations: 15,
    runValidationAfter: true,
    runPoGateAfter: false,
    timeoutMs: 45 * 60 * 1000,
  },
  {
    name: 'Frontend Implementation',
    description: 'All pages, components, forms, state management, responsive design',
    agentType: 'frontend',
    kind: 'implementation',
    outputs: [],
    maxIterations: 15,
    runValidationAfter: true,
    runPoGateAfter: false,
    timeoutMs: 45 * 60 * 1000,
  },
  {
    name: 'Unit & Integration Tests',
    description: 'Comprehensive test suite: Vitest unit + supertest integration',
    agentType: 'qa',
    kind: 'testing',
    outputs: [],
    maxIterations: 5,
    runValidationAfter: true,
    runPoGateAfter: false,
    timeoutMs: 20 * 60 * 1000,
  },
  {
    name: 'Browser QA',
    description: 'Playwright: all routes, forms, CRUD flows, console error check',
    agentType: 'qa',
    kind: 'validation',
    outputs: [],
    maxIterations: 3,
    runValidationAfter: false,
    runPoGateAfter: false,
    timeoutMs: 20 * 60 * 1000,
  },
  {
    name: 'Product Owner Gate',
    description: 'Validate all acceptance criteria from PRD are met',
    agentType: 'product-owner',
    kind: 'gate',
    outputs: ['po-review.md'],
    maxIterations: 1,
    runValidationAfter: false,
    runPoGateAfter: false,
    timeoutMs: 10 * 60 * 1000,
  },
  {
    name: 'Documentation',
    description: 'README, API reference, changelog, environment guide',
    agentType: 'tech-writer',
    kind: 'documentation',
    outputs: ['README.md', 'CHANGELOG.md'],
    maxIterations: 1,
    runValidationAfter: false,
    runPoGateAfter: false,
    timeoutMs: 10 * 60 * 1000,
  },
];

// ── Enterprise tier — 12 phases ──────────────────────────────────────────────

const ENTERPRISE_PHASES: PhaseDefinition[] = [
  {
    name: 'BRD & SRS',
    description: 'Business requirements document and software requirements specification',
    agentType: 'product-owner',
    kind: 'design',
    outputs: ['BRD.md', 'SRS.md'],
    maxIterations: 1,
    runValidationAfter: false,
    runPoGateAfter: false,
    timeoutMs: 15 * 60 * 1000,
  },
  {
    name: 'Architecture & ADRs',
    description: 'SDD, Architecture Decision Records, OpenAPI spec, ERD, task graph',
    agentType: 'architect',
    kind: 'design',
    outputs: ['SDD.md', 'ADRs/', 'api-spec.yaml', 'TASKS.md'],
    maxIterations: 1,
    runValidationAfter: false,
    runPoGateAfter: false,
    timeoutMs: 15 * 60 * 1000,
  },
  {
    name: 'Security Design',
    description: 'Threat model, security architecture, OWASP checklist',
    agentType: 'security-audit',
    kind: 'design',
    outputs: ['threat-model.md', 'security-design.md'],
    maxIterations: 1,
    runValidationAfter: false,
    runPoGateAfter: false,
    timeoutMs: 12 * 60 * 1000,
  },
  {
    name: 'Backend Implementation',
    description: 'Full backend: API, DB, auth, RBAC, business logic, unit tests',
    agentType: 'backend',
    kind: 'implementation',
    outputs: [],
    maxIterations: 20,
    runValidationAfter: true,
    runPoGateAfter: false,
    timeoutMs: 60 * 60 * 1000,
  },
  {
    name: 'Frontend Implementation',
    description: 'Full frontend: all pages, components, accessibility, responsive design',
    agentType: 'frontend',
    kind: 'implementation',
    outputs: [],
    maxIterations: 20,
    runValidationAfter: true,
    runPoGateAfter: false,
    timeoutMs: 60 * 60 * 1000,
  },
  {
    name: 'Unit Tests',
    description: 'Unit tests targeting 80%+ coverage of business logic',
    agentType: 'qa',
    kind: 'testing',
    outputs: [],
    maxIterations: 5,
    runValidationAfter: true,
    runPoGateAfter: false,
    timeoutMs: 25 * 60 * 1000,
  },
  {
    name: 'Integration Tests',
    description: 'API integration tests (supertest), database tests',
    agentType: 'qa',
    kind: 'testing',
    outputs: [],
    maxIterations: 5,
    runValidationAfter: true,
    runPoGateAfter: false,
    timeoutMs: 20 * 60 * 1000,
  },
  {
    name: 'Performance Tests',
    description: 'Load testing with autocannon/k6, measure p95 response times',
    agentType: 'qa',
    kind: 'validation',
    outputs: ['performance-report.md'],
    maxIterations: 2,
    runValidationAfter: false,
    runPoGateAfter: false,
    timeoutMs: 15 * 60 * 1000,
  },
  {
    name: 'Security Testing',
    description: 'SAST: npm audit, grep patterns, OWASP ZAP if available',
    agentType: 'security-audit',
    kind: 'validation',
    outputs: ['security-report.md'],
    maxIterations: 2,
    runValidationAfter: false,
    runPoGateAfter: false,
    timeoutMs: 20 * 60 * 1000,
  },
  {
    name: 'Browser QA',
    description: 'Full Playwright suite: all routes, auth flows, CRUD, accessibility',
    agentType: 'qa',
    kind: 'validation',
    outputs: [],
    maxIterations: 3,
    runValidationAfter: false,
    runPoGateAfter: false,
    timeoutMs: 25 * 60 * 1000,
  },
  {
    name: 'Quality Gate',
    description: 'PO validates: coverage, no critical bugs, performance SLAs, docs complete',
    agentType: 'product-owner',
    kind: 'gate',
    outputs: ['quality-gate-report.md'],
    maxIterations: 1,
    runValidationAfter: false,
    runPoGateAfter: false,
    timeoutMs: 12 * 60 * 1000,
  },
  {
    name: 'Documentation',
    description: 'README, operations runbook, API reference, ADR index, changelog',
    agentType: 'tech-writer',
    kind: 'documentation',
    outputs: ['README.md', 'RUNBOOK.md', 'CHANGELOG.md'],
    maxIterations: 1,
    runValidationAfter: false,
    runPoGateAfter: false,
    timeoutMs: 15 * 60 * 1000,
  },
];

// ── Lookup ────────────────────────────────────────────────────────────────────

const PHASES_BY_TIER: Record<Tier, PhaseDefinition[]> = {
  small: SMALL_PHASES,
  medium: MEDIUM_PHASES,
  enterprise: ENTERPRISE_PHASES,
};

/**
 * Load custom phase definitions from `.aico/pipeline.json` or `.aico/pipeline.yaml`
 * in the project directory. Returns null if no custom pipeline file exists.
 *
 * This makes the studio pipeline user-definable — a project can define its own
 * phases, agent types, iteration counts, validation gates, and per-phase models
 * without modifying aico's source code.
 *
 * JSON format:
 * ```json
 * {
 *   "phases": [
 *     { "name": "Design", "agentType": "architect", "kind": "design", "model": "claude-sonnet-5" },
 *     { "name": "Backend", "agentType": "backend", "kind": "implementation", "maxIterations": 15, "model": "glm-4.6" }
 *   ]
 * }
 * ```
 */
export async function loadCustomPhases(projectDir: string): Promise<PhaseDefinition[] | null> {
  const { readFile } = await import('fs/promises');
  const { join } = await import('path');
  const VALID_AGENT_TYPES = new Set(['architect', 'backend', 'frontend', 'qa', 'tech-writer', 'product-owner', 'security-audit', 'healer']);
  const VALID_KINDS = new Set(['design', 'implementation', 'testing', 'validation', 'gate', 'documentation']);

  for (const file of ['pipeline.json', 'pipeline.yaml', 'pipeline.yml']) {
    const filePath = join(projectDir, '.aico', file);
    try {
      const content = await readFile(filePath, 'utf8');
      // Simple JSON parsing for .json; for .yaml/.yml, try JSON first (many YAML files are valid JSON)
      let parsed: { phases?: unknown[] };
      try {
        parsed = JSON.parse(content);
      } catch {
        // Not valid JSON — skip (would need a YAML parser for full .yaml support)
        continue;
      }

      if (!Array.isArray(parsed.phases) || parsed.phases.length === 0) continue;

      // Parse each phase with defaults and validation
      const phases: PhaseDefinition[] = parsed.phases.map((raw: unknown, i: number) => {
        const p = raw as Record<string, unknown>;
        const agentType = String(p.agentType ?? 'general') as PhaseAgentType;
        const kind = String(p.kind ?? 'design') as PhaseKind;
        if (!VALID_AGENT_TYPES.has(agentType)) {
          throw new Error(`Phase ${i}: invalid agentType "${agentType}"`);
        }
        if (!VALID_KINDS.has(kind)) {
          throw new Error(`Phase ${i}: invalid kind "${kind}"`);
        }
        return {
          name: String(p.name ?? `Phase ${i + 1}`),
          description: String(p.description ?? ''),
          agentType,
          kind,
          outputs: Array.isArray(p.outputs) ? p.outputs.map(String) : [],
          maxIterations: Number(p.maxIterations ?? 10),
          runValidationAfter: Boolean(p.runValidationAfter ?? (kind === 'implementation')),
          runPoGateAfter: Boolean(p.runPoGateAfter ?? (kind === 'gate')),
          timeoutMs: Number(p.timeoutMs ?? 15 * 60 * 1000),
          ...(p.model ? { model: String(p.model) } : {}),
          ...(Array.isArray(p.docs) ? { docs: p.docs.map(String) } : {}),
          ...(p.condition ? { condition: String(p.condition) } : {}),
        };
      });

      return phases;
    } catch {
      // File doesn't exist or is invalid — try the next format
    }
  }
  return null;
}

/**
 * Get phases for a tier, with optional custom override.
 * If a custom pipeline file exists in the project, it replaces the built-in
 * phases for all tiers. Otherwise, the built-in tier-specific phases are used.
 */
export async function getPhasesForTierWithOverride(tier: Tier, projectDir: string): Promise<PhaseDefinition[]> {
  const custom = await loadCustomPhases(projectDir);
  return custom ?? PHASES_BY_TIER[tier];
}

export function getPhasesForTier(tier: Tier): PhaseDefinition[] {
  return PHASES_BY_TIER[tier];
}

export function getPhase(tier: Tier, phaseIndex: number): PhaseDefinition | undefined {
  return PHASES_BY_TIER[tier][phaseIndex - 1];
}
