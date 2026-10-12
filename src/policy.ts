import { z } from 'zod';
import type { PolicyConfig } from './contracts.js';

const classPolicy = z.object({ local_eligible: z.boolean(), review: z.enum(['checks-only', 'local', 'frontier']) }).strict();
export const policySchema = z.object({
  version: z.literal(1),
  classes: z.object({ tests: classPolicy, 'small-fix': classPolicy, mechanical: classPolicy,
    'small-feature': classPolicy, risky: classPolicy, design: classPolicy }).strict(),
  max_repairs: z.union([z.literal(0), z.literal(1)]),
  review_timeout_minutes: z.number().int().min(1).max(30),
}).strict().superRefine((policy, context) => {
  if (policy.classes.design.local_eligible) context.addIssue({ code: z.ZodIssueCode.custom, path: ['classes','design','local_eligible'], message: 'Design tasks can never run locally' });
  if (policy.classes.risky.review !== 'frontier') context.addIssue({ code: z.ZodIssueCode.custom, path: ['classes','risky','review'], message: 'Risky tasks require frontier review' });
});

export function defaultPolicy(): PolicyConfig {
  return { version: 1, classes: {
    tests: { local_eligible: true, review: 'local' }, 'small-fix': { local_eligible: true, review: 'local' },
    mechanical: { local_eligible: true, review: 'local' }, 'small-feature': { local_eligible: true, review: 'local' },
    risky: { local_eligible: false, review: 'frontier' }, design: { local_eligible: false, review: 'frontier' },
  }, max_repairs: 1, review_timeout_minutes: 10 };
}
/** Parsing returns a deep copy so callers cannot mutate the effective shared policy. */
export function getPolicy(policy?: PolicyConfig): PolicyConfig { return policySchema.parse(policy ?? defaultPolicy()); }
