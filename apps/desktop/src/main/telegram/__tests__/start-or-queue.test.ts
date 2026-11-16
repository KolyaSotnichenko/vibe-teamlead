import { describe, expect, it } from 'vitest';

import { startOrQueue } from '../start-or-queue';

const task = (id: string, status: string) => ({ id, specId: id, status }) as never;

describe('startOrQueue (the bot\'s Start)', () => {
  it('starts when a slot is free and the queue runs', () => {
    expect(startOrQueue({ paused: false, tasks: [task('a', 'in_progress'), task('b', 'backlog')], limit: 2, taskId: 'b' })).toBe('start');
  });

  // From the phone the board's limit holds as on the computer: more agents than allowed cost money
  it('queues when the parallel limit is reached', () => {
    expect(startOrQueue({ paused: false, tasks: [task('a', 'in_progress'), task('b', 'backlog')], limit: 1, taskId: 'b' })).toBe('queue');
  });

  it('queues while the queue is paused (/stop_all), whatever the slots', () => {
    expect(startOrQueue({ paused: true, tasks: [task('b', 'backlog')], limit: 3, taskId: 'b' })).toBe('queue');
  });
});
