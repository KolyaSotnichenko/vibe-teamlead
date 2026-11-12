/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { listenOpenDeploy } from '../open-deploy';

describe('listenOpenDeploy', () => {
  it('passes the open-deploy target to the handler and stops after unsubscribe', () => {
    const handler = vi.fn();
    const off = listenOpenDeploy(handler);
    window.dispatchEvent(new CustomEvent('open-deploy', { detail: { tab: 'runs', runId: 5, jobId: 9 } }));
    expect(handler).toHaveBeenCalledWith({ tab: 'runs', runId: 5, jobId: 9 });
    off();
    window.dispatchEvent(new CustomEvent('open-deploy', { detail: {} }));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('gives an empty target when the event has no detail', () => {
    const handler = vi.fn();
    const off = listenOpenDeploy(handler);
    window.dispatchEvent(new CustomEvent('open-deploy'));
    expect(handler).toHaveBeenCalledWith({});
    off();
  });
});
