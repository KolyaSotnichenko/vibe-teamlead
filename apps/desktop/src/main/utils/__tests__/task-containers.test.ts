import { describe, expect, it } from 'vitest';

import { composeProjectName, removeTaskContainers } from '../task-containers';

const WT = '/p/.vibe-teamlead/worktrees/tasks/014-build-dashboard';

/** Docker with these containers, volumes and networks. Answers like the real one. */
function fakeDocker(state: { containers?: string[]; volumes?: string[]; networks?: string[]; down?: boolean } = {}) {
  const calls: string[][] = [];
  const docker = async (args: string[]) => {
    calls.push(args);
    if (state.down) return { ok: false, stdout: 'Cannot connect' };
    if (args[0] === 'ps') return { ok: true, stdout: (state.containers ?? []).join('\n') };
    if (args[0] === 'volume' && args[1] === 'ls') return { ok: true, stdout: (state.volumes ?? []).join('\n') };
    if (args[0] === 'network' && args[1] === 'ls') return { ok: true, stdout: (state.networks ?? []).join('\n') };
    return { ok: true, stdout: '' };
  };
  return { docker, calls };
}
const row = (id: string, dir: string) => `${id}\t${dir}`;

describe('removeTaskContainers', () => {
  it("removes what an agent's compose left for this task", async () => {
    const { docker, calls } = fakeDocker({ containers: [row('c1', WT)], volumes: ['v1'], networks: ['n1'] });
    await removeTaskContainers(WT, docker);
    expect(calls).toContainEqual(['rm', '-f', '-v', 'c1']);
    expect(calls).toContainEqual(['volume', 'rm', 'v1']);
    expect(calls).toContainEqual(['network', 'rm', 'n1']);
  });

  it('asks for volumes and networks of this task only', async () => {
    const { docker, calls } = fakeDocker({});
    await removeTaskContainers(WT, docker);
    expect(calls).toContainEqual(['volume', 'ls', '-q', '--filter', 'label=com.docker.compose.project=014-build-dashboard']);
    expect(calls).toContainEqual(['network', 'ls', '-q', '--filter', 'label=com.docker.compose.project=014-build-dashboard']);
  });

  it('takes a project started from a folder inside the task', async () => {
    const { docker, calls } = fakeDocker({ containers: [row('c1', `${WT}/apps/api`)] });
    await removeTaskContainers(WT, docker);
    expect(calls).toContainEqual(['rm', '-f', '-v', 'c1']);
  });

  it("never touches anyone else's containers, other tasks with a similar name included", async () => {
    const { docker, calls } = fakeDocker({ containers: [row('other', '/Users/n/planeit'), row('similar', `${WT}-2`), row('plain', '')] });
    await removeTaskContainers(WT, docker);
    expect(calls.filter((call) => call[0] === 'rm')).toEqual([]);
  });

  it('without Docker there is nothing to do, and no error', async () => {
    const { docker, calls } = fakeDocker({ down: true });
    await expect(removeTaskContainers(WT, docker)).resolves.toBeUndefined();
    expect(calls.filter((call) => call[0] === 'rm')).toEqual([]);
  });

  it('a Docker that throws stops nothing: the task still gets cleaned up', async () => {
    await expect(removeTaskContainers(WT, async () => { throw new Error('no'); })).resolves.toBeUndefined();
  });
});

describe('composeProjectName', () => {
  it('names the project as compose does from a folder', () => {
    expect(composeProjectName('/x/014-Build Dashboard!')).toBe('014-builddashboard');
  });
});
