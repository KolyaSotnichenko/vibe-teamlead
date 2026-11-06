/**
 * What a model cost through the gateway, and since when. A new price counts from the
 * day it is entered, so sessions before it keep the price they ran at. Pure.
 */

import type { DatedModelPrice, GatewayPrices, ModelPrice } from '../types/usage';

const listOf = (prices: GatewayPrices | undefined, model: string): DatedModelPrice[] => {
  // Own keys only: model names come from a ledger file agents can reach
  const value = prices && Object.hasOwn(prices, model) ? prices[model] : undefined;
  if (!value) return [];
  return Array.isArray(value) ? value : [{ ...value, from: '' }];
};

/** The price a session at this time ran at. History before the first price uses the first: there is no other. */
export function priceAt(prices: GatewayPrices | undefined, model: string, at: string | undefined): ModelPrice | undefined {
  const list = listOf(prices, model);
  if (!list.length) return undefined;
  if (!at) return list[list.length - 1];
  let found = list[0];
  for (const price of list) if (price.from <= at) found = price;
  return found;
}

export function currentPrice(prices: GatewayPrices | undefined, model: string): DatedModelPrice | undefined {
  const list = listOf(prices, model);
  return list[list.length - 1];
}

const samePrice = (a: ModelPrice, b: ModelPrice) => a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite;

/** The list with this price added. The same day replaces: a corrected typo is not a price change. */
export function withNewPrice(list: DatedModelPrice[] | ModelPrice | undefined, price: ModelPrice, now: string): DatedModelPrice[] {
  const current = listOf(list ? { m: list } : undefined, 'm');
  const last = current[current.length - 1];
  if (!last) return [{ ...price, from: '', enteredAt: now }];
  if (samePrice(last, price)) return current;
  if ((last.enteredAt ?? last.from).slice(0, 10) === now.slice(0, 10)) return [...current.slice(0, -1), { ...price, from: last.from, enteredAt: now }];
  return [...current, { ...price, from: now, enteredAt: now }];
}

/** Cached reads dearer than input: providers charge less for them, so two fields were probably swapped. */
export function priceLooksSwapped(price: ModelPrice): boolean {
  return price.cacheRead > price.input;
}
