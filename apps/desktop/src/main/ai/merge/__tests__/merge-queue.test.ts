import { describe, expect, it, vi } from 'vitest';

import { inMergeQueue, isMergeQueued } from '../merge-queue';

const deferred = () => {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

describe('inMergeQueue', () => {
  it('runs one merge of a project at a time, in the order they came', async () => {
    const order: string[] = [];
    const first = deferred();
    const a = inMergeQueue('/project', 'a', async () => {
      order.push('a starts');
      await first.promise;
      order.push('a ends');
    });
    const b = inMergeQueue('/project', 'b', async () => { order.push('b'); });
    const c = inMergeQueue('/project', 'c', async () => { order.push('c'); });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual(['a starts']);

    first.resolve();
    await Promise.all([a, b, c]);
    expect(order).toEqual(['a starts', 'a ends', 'b', 'c']);
  });

  it('runs merges of different projects side by side', async () => {
    const first = deferred();
    const a = inMergeQueue('/one', 'a', () => first.promise);
    await expect(inMergeQueue('/two', 'b', async () => 'done')).resolves.toBe('done');
    first.resolve();
    await a;
  });

  it('a failed merge does not hold up the next, and its error reaches its caller', async () => {
    const failed = inMergeQueue('/fail', 'a', async () => { throw new Error('no'); });
    const next = inMergeQueue('/fail', 'b', async () => 'next');
    await expect(failed).rejects.toThrow('no');
    await expect(next).resolves.toBe('next');
  });

  it('says when a merge has to wait, and not when it is first', async () => {
    const first = deferred();
    const firstWait = vi.fn();
    const secondWait = vi.fn();
    const a = inMergeQueue('/wait', 'a', () => first.promise, firstWait);
    const b = inMergeQueue('/wait', 'b', async () => {}, secondWait);
    expect(firstWait).not.toHaveBeenCalled();
    expect(secondWait).toHaveBeenCalledWith(1);
    first.resolve();
    await Promise.all([a, b]);
  });

  it('knows which tasks are in the queue, until they are done', async () => {
    const first = deferred();
    const a = inMergeQueue('/known', 'task-a', () => first.promise);
    expect(isMergeQueued('task-a')).toBe(true);
    first.resolve();
    await a;
    expect(isMergeQueued('task-a')).toBe(false);
  });
});
