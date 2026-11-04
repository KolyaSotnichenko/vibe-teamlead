import { describe, expect, it, vi } from 'vitest';

import { createQuitGuard, quitPrompt } from '../quit-guard';

describe('createQuitGuard', () => {
  it('quits without a question when nothing is running', () => {
    const ask = vi.fn(() => false);
    expect(createQuitGuard({ running: () => [], ask }).confirm()).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks while tasks run, and stays open on no', () => {
    const ask = vi.fn(() => false);
    expect(createQuitGuard({ running: () => ['a', 'b'], ask }).confirm()).toBe(false);
    expect(ask).toHaveBeenCalledWith(2);
  });

  it('asks once on the way out: Cmd+Q and the window closing are one quit', () => {
    const ask = vi.fn(() => true);
    const guard = createQuitGuard({ running: () => ['a'], ask });
    expect(guard.confirm()).toBe(true);
    expect(guard.confirm()).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('asks again after a no', () => {
    const ask = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const guard = createQuitGuard({ running: () => ['a'], ask });
    expect(guard.confirm()).toBe(false);
    expect(guard.confirm()).toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
  });
});

describe('quitPrompt', () => {
  it('speaks the app language, keeps working as the safe default, and falls back to English', () => {
    const uk = quitPrompt('uk', 2);
    expect(uk.message).toContain('2');
    expect(uk.buttons[0]).toBe('Лишити працювати');
    expect(quitPrompt('en', 1).buttons[0]).toBe('Keep working');
    expect(quitPrompt('fr', 1).buttons[0]).toBe('Keep working');
  });
});
