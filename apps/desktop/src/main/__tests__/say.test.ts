import { describe, expect, it } from 'vitest';

import { saidFor, say } from '../say';

describe('say: sentences the main process says to the owner', () => {
  it('gives back the English sentence, and remembers which key and values it was made from', () => {
    const text = say('serviceNotStarted', 'api did not start', { service: 'api' });
    expect(text).toBe('api did not start');
    expect(saidFor([text])).toEqual([{ key: 'serviceNotStarted', params: { service: 'api' }, text }]);
  });

  it('knows nothing about text it did not make, and skips what is missing', () => {
    expect(saidFor(['pnpm: command not found', undefined, ''])).toEqual([]);
  });

  it('answers once for a sentence said twice, and keeps the latest values', () => {
    say('composeNotReady', 'search (x) did not get ready in time.', { name: 'search', image: 'x' });
    say('composeNotReady', 'search (x) did not get ready in time.', { name: 'search', image: 'x' });
    expect(saidFor(['search (x) did not get ready in time.', 'search (x) did not get ready in time.'])).toHaveLength(1);
  });

  it('forgets the oldest sentences rather than growing without end', () => {
    const first = say('migrationsFailed', 'The migrations failed in run 0');
    for (let i = 1; i <= 600; i++) say('migrationsFailed', `The migrations failed in run ${i}`);
    expect(saidFor([first])).toEqual([]);
    expect(saidFor(['The migrations failed in run 600'])).toHaveLength(1);
  });
});
