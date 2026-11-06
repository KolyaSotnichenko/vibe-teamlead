import { describe, expect, it } from 'vitest';

import { currentPrice, priceAt, withNewPrice } from '../gateway-prices';

const cheap = { input: 1, output: 2, cacheRead: 0.1 };
const dear = { input: 3, output: 6, cacheRead: 0.3 };

describe('gateway prices by date', () => {
  it('a first price covers all the history before it: there is no other to use', () => {
    const prices = { m: withNewPrice(undefined, cheap, '2026-11-06T10:00:00.000Z') };
    expect(priceAt(prices, 'm', '2020-01-01T00:00:00.000Z')).toMatchObject(cheap);
  });

  it('a later price counts from its date, and earlier sessions keep the old one', () => {
    const list = withNewPrice(withNewPrice(undefined, cheap, '2026-11-06T10:00:00.000Z'), dear, '2026-12-01T10:00:00.000Z');
    const prices = { m: list };
    expect(priceAt(prices, 'm', '2026-11-20T00:00:00.000Z')).toMatchObject(cheap);
    expect(priceAt(prices, 'm', '2026-12-01T10:00:00.000Z')).toMatchObject(dear);
    expect(priceAt(prices, 'm', '2027-01-01T00:00:00.000Z')).toMatchObject(dear);
  });

  it('correcting a price the same day replaces it: a typo is not a price change', () => {
    const first = withNewPrice(withNewPrice(undefined, cheap, '2026-11-06T10:00:00.000Z'), dear, '2026-12-01T10:00:00.000Z');
    const corrected = withNewPrice(first, { input: 4, output: 6, cacheRead: 0.3 }, '2026-12-01T18:00:00.000Z');
    expect(corrected).toHaveLength(2);
    expect(corrected[1].input).toBe(4);
  });

  it('saving the same price adds nothing', () => {
    const first = withNewPrice(undefined, cheap, '2026-11-06T10:00:00.000Z');
    expect(withNewPrice(first, cheap, '2026-12-01T10:00:00.000Z')).toHaveLength(1);
  });

  it('reads a price saved before dates existed', () => {
    expect(priceAt({ m: cheap }, 'm', '2026-11-06T10:00:00.000Z')).toMatchObject(cheap);
    expect(currentPrice({ m: cheap }, 'm')).toMatchObject(cheap);
  });

  it('a session with no date gets the current price', () => {
    const prices = { m: withNewPrice(withNewPrice(undefined, cheap, '2026-11-06T10:00:00.000Z'), dear, '2026-12-01T10:00:00.000Z') };
    expect(priceAt(prices, 'm', undefined)).toMatchObject(dear);
  });

  it("no price for a model it doesn't know, and a name can't reach Object's prototype", () => {
    expect(priceAt({}, 'm', undefined)).toBeUndefined();
    expect(priceAt({}, '__proto__', undefined)).toBeUndefined();
    expect(currentPrice({}, 'constructor')).toBeUndefined();
  });
});
