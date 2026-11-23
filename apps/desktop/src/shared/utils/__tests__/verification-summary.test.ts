import { describe, expect, it } from 'vitest';

import { parseVerificationSummary } from '../verification-summary';

describe('parseVerificationSummary', () => {
  const good = { status: 'not_verified', commit: 'abc', checks: [{ command: 'npm test', outcome: 'failed', onBase: 'failed' }], services: { status: 'unavailable', images: ['postgres:18'] }, migrationsSkipped: true };

  it('reads what the app wrote', () => {
    expect(parseVerificationSummary(JSON.stringify(good))).toEqual(good);
  });

  it.each([['not json'], ['null'], ['[]'], ['{"status":"made-up","checks":[]}'], ['{"status":"passed"}']])('nothing from %s: agents can reach this file', (text) => {
    expect(parseVerificationSummary(text)).toBeNull();
  });

  it('reads why a start was not judged, with the ports, and drops what is not a port', () => {
    const parsed = parseVerificationSummary(JSON.stringify({ status: 'not_verified', checks: [{ command: 'start the project by its recipe', outcome: 'unavailable', why: { reason: 'port', ports: [10000, 'x', 70000, 3000.5] } }] }));
    expect(parsed?.checks[0].why).toEqual({ reason: 'port', ports: [10000] });
  });

  it('drops malformed checks rather than showing them', () => {
    const parsed = parseVerificationSummary(JSON.stringify({ status: 'passed', checks: [{ command: 'ok', outcome: 'passed' }, { command: 1 }, { command: 'x', outcome: 'made-up' }] }));
    expect(parsed?.checks).toEqual([{ command: 'ok', outcome: 'passed' }]);
  });

  it('ignores services in an unknown state', () => {
    expect(parseVerificationSummary(JSON.stringify({ status: 'passed', checks: [], services: { status: 'x' } }))?.services).toBeUndefined();
  });
});
