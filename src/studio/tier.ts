/**
 * Tier detection — pure synchronous function, no external calls.
 * Analyzes requirement text and scores it against signal patterns.
 */

import type { Tier } from './state.js';

export type { Tier };

export interface TierDetectionResult {
  tier: Tier;
  confidence: number;      // 0-1
  signals: string[];       // human-readable reasons
  phaseCount: number;
}

export interface TierDetectionOpts {
  forceTier?: Tier;
}

interface TierSignal {
  pattern: RegExp;
  label: string;
}

// ── Signal patterns ──────────────────────────────────────────────────────────

const ENTERPRISE_SIGNALS: TierSignal[] = [
  { pattern: /multi.?tenant/i,           label: 'multi-tenant' },
  { pattern: /compliance/i,              label: 'compliance' },
  { pattern: /SOC\s*2/i,                label: 'SOC2' },
  { pattern: /HIPAA/i,                   label: 'HIPAA' },
  { pattern: /GDPR/i,                    label: 'GDPR' },
  { pattern: /PCI/i,                     label: 'PCI-DSS' },
  { pattern: /audit.?log/i,              label: 'audit-logging' },
  { pattern: /RBAC|role.based/i,         label: 'RBAC' },
  { pattern: /SSO/i,                     label: 'SSO' },
  { pattern: /SAML/i,                    label: 'SAML' },
  { pattern: /microservice/i,            label: 'microservices' },
  { pattern: /kubernetes|k8s/i,          label: 'kubernetes' },
  { pattern: /\bSLA\b/i,                label: 'SLA' },
  { pattern: /99\.9|high.?availability/i, label: 'high-availability' },
  { pattern: /disaster.?recovery/i,      label: 'disaster-recovery' },
  { pattern: /financial|fintech/i,       label: 'financial' },
  { pattern: /healthcare|medical/i,      label: 'healthcare' },
  { pattern: /regulatory|regulation/i,   label: 'regulatory' },
  { pattern: /\benterprise\b/i,          label: 'enterprise' },
  { pattern: /10[,\s]?000\+|hundred.?thousand/i, label: '10k+ users' },
  { pattern: /data.?warehouse|ETL/i,     label: 'data-warehouse' },
  { pattern: /event.?sourcing|CQRS/i,    label: 'event-sourcing' },
  { pattern: /distributed.?system/i,     label: 'distributed-system' },
];

const MEDIUM_SIGNALS: TierSignal[] = [
  { pattern: /\bSaaS\b/i,               label: 'SaaS' },
  { pattern: /billing|payment/i,         label: 'billing' },
  { pattern: /Stripe|PayPal|Braintree/i, label: 'payment-gateway' },
  { pattern: /subscription/i,           label: 'subscriptions' },
  { pattern: /\bteam\b|\bworkspace\b/i,  label: 'team-collaboration' },
  { pattern: /real.?time|websocket|live/i, label: 'real-time' },
  { pattern: /webhook/i,                 label: 'webhooks' },
  { pattern: /notification|email|SMS/i,  label: 'notifications' },
  { pattern: /dashboard|analytics/i,     label: 'dashboard' },
  { pattern: /reporting|report/i,        label: 'reporting' },
  { pattern: /import|export|CSV|Excel/i, label: 'import-export' },
  { pattern: /REST.?API|GraphQL/i,       label: 'API' },
  { pattern: /OAuth|social.?login/i,     label: 'OAuth' },
  { pattern: /search|Elasticsearch/i,    label: 'search' },
  { pattern: /caching|Redis/i,           label: 'caching' },
  { pattern: /file.?upload|S3|storage/i, label: 'file-storage' },
  { pattern: /multi.?user|user.?management/i, label: 'multi-user' },
  { pattern: /CRM|ERP|HRM/i,            label: 'business-system' },
  { pattern: /marketplace|e.?commerce/i, label: 'marketplace' },
];

const SMALL_SIGNALS: TierSignal[] = [
  { pattern: /\btodo\b/i,               label: 'todo-app' },
  { pattern: /\bsimple\b/i,             label: 'simple' },
  { pattern: /\bbasic\b/i,              label: 'basic' },
  { pattern: /\bpersonal\b/i,           label: 'personal' },
  { pattern: /\bprototype\b|\bproof.of.concept\b|\bPOC\b/i, label: 'prototype' },
  { pattern: /\bdemo\b/i,               label: 'demo' },
  { pattern: /\bsmall\b/i,              label: 'small' },
  { pattern: /\bquick\b/i,              label: 'quick' },
  { pattern: /single.?user/i,           label: 'single-user' },
  { pattern: /\bscript\b|\butility\b/i, label: 'utility' },
  { pattern: /\bweekend.?project\b/i,   label: 'weekend-project' },
];

const PHASE_COUNT: Record<Tier, number> = {
  small: 5,
  medium: 8,
  enterprise: 12,
};

// ── Detection function ────────────────────────────────────────────────────────

export function detectTier(
  requirements: string,
  opts?: TierDetectionOpts,
): TierDetectionResult {
  if (opts?.forceTier) {
    return {
      tier: opts.forceTier,
      confidence: 1,
      signals: ['forced by --tier flag'],
      phaseCount: PHASE_COUNT[opts.forceTier],
    };
  }

  let enterpriseScore = 0;
  let mediumScore = 0;
  let smallScore = 0;
  const signals: string[] = [];

  for (const sig of ENTERPRISE_SIGNALS) {
    if (sig.pattern.test(requirements)) {
      enterpriseScore++;
      signals.push(`enterprise:${sig.label}`);
    }
  }
  for (const sig of MEDIUM_SIGNALS) {
    if (sig.pattern.test(requirements)) {
      mediumScore++;
      signals.push(`medium:${sig.label}`);
    }
  }
  for (const sig of SMALL_SIGNALS) {
    if (sig.pattern.test(requirements)) {
      smallScore++;
      signals.push(`small:${sig.label}`);
    }
  }

  // Word count bonus: long requirements → likely not small
  const wordCount = requirements.split(/\s+/).length;
  if (wordCount > 300) mediumScore++;
  if (wordCount > 600) enterpriseScore++;

  // Scoring logic
  let tier: Tier;
  let confidence: number;

  if (enterpriseScore >= 3) {
    tier = 'enterprise';
    confidence = Math.min(1, 0.6 + enterpriseScore * 0.07);
  } else if (mediumScore >= 2 || (mediumScore >= 1 && enterpriseScore >= 1)) {
    tier = 'medium';
    confidence = Math.min(1, 0.55 + mediumScore * 0.08);
  } else {
    tier = 'small';
    // If there are medium signals but not enough, lower confidence
    confidence = mediumScore > 0 ? 0.5 : Math.min(1, 0.6 + smallScore * 0.1);
  }

  return {
    tier,
    confidence,
    signals,
    phaseCount: PHASE_COUNT[tier],
  };
}

export function formatTierSummary(result: TierDetectionResult): string {
  const { tier, confidence, signals, phaseCount } = result;
  const pct = Math.round(confidence * 100);
  const topSignals = signals.slice(0, 5).join(', ');
  return `${tier} (${pct}% confidence, ${phaseCount} phases) — signals: ${topSignals || 'default'}`;
}
