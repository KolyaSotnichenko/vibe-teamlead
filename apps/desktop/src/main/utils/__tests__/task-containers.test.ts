import { describe, expect, it } from 'vitest';

import { composeProjectName, labelDockerRuns, removeTaskContainers } from '../task-containers';

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

  it('removes a container an agent started with docker run for this task', async () => {
    const { docker, calls } = fakeDocker({ containers: [`c1\t\t${WT}`] });
    await removeTaskContainers(WT, docker);
    expect(calls).toContainEqual(['rm', '-f', '-v', 'c1']);
  });

  it("leaves a docker run container of another task alone", async () => {
    const { docker, calls } = fakeDocker({ containers: [`c1\t\t${WT}-2`] });
    await removeTaskContainers(WT, docker);
    expect(calls.filter((call) => call[0] === 'rm')).toEqual([]);
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

describe('labelDockerRuns', () => {
  const label = `--label 'vibe-teamlead.task-folder=${WT}'`;

  it('marks a container the agent starts', () => {
    expect(labelDockerRuns('docker run -d postgres:18', WT)).toBe(`docker run ${label} -d postgres:18`);
    expect(labelDockerRuns('docker container run -d pg', WT)).toBe(`docker container run ${label} -d pg`);
  });

  it('marks it wherever it is in the command', () => {
    expect(labelDockerRuns('docker rm -f a >/dev/null 2>&1; docker run -d pg && sleep 1', WT)).toBe(`docker rm -f a >/dev/null 2>&1; docker run ${label} -d pg && sleep 1`);
  });

  it("leaves everything else as it is: a search for the words, compose's own run, other docker commands", () => {
    for (const command of ['grep "docker run" README.md', 'docker compose run api', 'docker ps', 'npm run test', 'echo docker run']) {
      expect(labelDockerRuns(command, WT)).toBe(command);
    }
  });

  it('leaves text alone: a script being written, a commit message, a command in quotes', () => {
    for (const command of [
      "bash -c 'a; docker run pg'",
      'bash -c "a; docker run pg"',
      'git commit -m "first\ndocker run pg"',
      "git commit -m 'it\ndocker run pg'",
      'cat > start.sh <<EOF\ndocker run pg\nEOF',
      'echo "say \\"hi; docker run pg"',
    ]) {
      expect(labelDockerRuns(command, WT)).toBe(command);
    }
  });

  it('still marks a container after a quoted part has closed', () => {
    expect(labelDockerRuns('echo "a b" && docker run pg', WT)).toBe(`echo "a b" && docker run ${label} pg`);
  });

  it('a backslash inside single quotes closes nothing and opens nothing', () => {
    expect(labelDockerRuns("echo 'a\\' && docker run pg", WT)).toBe(`echo 'a\\' && docker run ${label} pg`);
  });

  it('keeps a folder with a quote in it from breaking out of the command', () => {
    expect(labelDockerRuns('docker run pg', "/a'; rm -rf x '")).toBe(`docker run --label 'vibe-teamlead.task-folder=/a'\\''; rm -rf x '\\''' pg`);
  });
});
