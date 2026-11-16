/**
 * Pairing: Settings shows a one-time code, valid 10 minutes; `/start <code>` from Telegram makes
 * the sender the owner. A code works once; a new one replaces the old.
 */

import { randomInt } from 'node:crypto';

export const PAIRING_VALID_MS = 10 * 60_000;
/** No 0/O, 1/I/L: the code may be typed by hand */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LENGTH = 8;

export interface PairingCode {
  code: string;
  expiresAt: number;
}

export interface Pairing {
  /** A new code (the old one stops working) */
  issue(): PairingCode;
  /** The code while it is valid */
  current(): PairingCode | undefined;
  /** True (and the code is used up) when the text is the valid code */
  consume(text: string): boolean;
  clear(): void;
}

export function createPairing(options: { now?: () => number; random?: (max: number) => number } = {}): Pairing {
  const now = options.now ?? Date.now;
  const random = options.random ?? ((max: number) => randomInt(max));
  let active: PairingCode | undefined;

  const valid = () => (active && now() < active.expiresAt ? active : undefined);

  return {
    issue() {
      let code = '';
      for (let i = 0; i < LENGTH; i++) code += ALPHABET[random(ALPHABET.length)];
      active = { code, expiresAt: now() + PAIRING_VALID_MS };
      return active;
    },
    current: valid,
    consume(text: string) {
      const code = valid();
      if (!code || text.trim().toUpperCase() !== code.code) return false;
      active = undefined;
      return true;
    },
    clear() {
      active = undefined;
    },
  };
}
