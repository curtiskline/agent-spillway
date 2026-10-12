import { describe, expect, it } from 'vitest';
import { defaultPolicy, getPolicy, policySchema } from '../src/policy.js';

describe('versioned deterministic policy', () => {
  it('defaults to design section six with one repair and bounded local review', () => {
    const policy = defaultPolicy();
    for (const name of ['tests','small-fix','mechanical','small-feature'] as const) expect(policy.classes[name]).toEqual({ local_eligible: true,review: 'local' });
    expect(policy.classes.risky).toEqual({ local_eligible: false,review: 'frontier' });
    expect(policy.classes.design.local_eligible).toBe(false);
    expect(policy.max_repairs).toBe(1); expect(policy.review_timeout_minutes).toBe(10);
  });
  it('returns independent copies and preserves explicit class overrides', () => {
    const initial = defaultPolicy(); initial.classes.mechanical.review = 'checks-only';
    const effective = getPolicy(initial); effective.classes.mechanical.review = 'frontier';
    expect(initial.classes.mechanical.review).toBe('checks-only'); expect(getPolicy().classes.mechanical.review).toBe('local');
  });
  it('rejects attempts to make design locally eligible or risky review weaker', () => {
    const design = defaultPolicy(); design.classes.design.local_eligible = true; expect(() => getPolicy(design)).toThrow(/never run locally/);
    const risky = defaultPolicy(); risky.classes.risky.review = 'local'; expect(() => getPolicy(risky)).toThrow(/frontier/);
  });
  it.each([ { max_repairs: 2 }, { max_repairs: -1 }, { review_timeout_minutes: 0 }, { review_timeout_minutes: 31 }, { review_timeout_minutes: 1.5 }, { version: 2 }, { extra: true } ])('rejects invalid policy %j', value => {
    expect(policySchema.safeParse({ ...defaultPolicy(), ...value }).success).toBe(false);
  });
  it('requires an explicit known policy for every task class', () => {
    const classes: Record<string, unknown> = { ...defaultPolicy().classes }; delete classes.design;
    expect(policySchema.safeParse({ ...defaultPolicy(),classes }).success).toBe(false);
    expect(policySchema.safeParse({ ...defaultPolicy(),classes: { ...defaultPolicy().classes, unknown: { local_eligible: true, review: 'local' } } }).success).toBe(false);
  });
});
