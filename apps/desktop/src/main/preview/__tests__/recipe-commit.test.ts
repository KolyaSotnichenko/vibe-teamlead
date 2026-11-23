import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { recipeHash } from '../recipe';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { isWindowsHost } from '../../platform/__tests__/host';
import { saidFor } from '../../say';
import { commitRecipeToMain, mainRecipeText, RECIPE_BRANCH } from '../recipe-commit';

const TEXT = '{\n  "version": 1,\n  "kind": "none"\n}\n';
const OTHER = '{\n  "version": 1,\n  "kind": "desktop"\n}\n';

describe('the app commits a recipe into main', () => {
  let repo: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const init = (branch = 'main', identity = true) => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'vtl-recipe-')));
    git('init', '-q', '-b', branch);
    git('config', 'core.autocrlf', 'false');
    if (identity) {
      git('config', 'user.email', 't@t');
      git('config', 'user.name', 't');
    }
    writeFileSync(join(repo, 'shared.txt'), 'one\n');
    git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'first');
  };
  const commit = (text: string, over: Partial<Parameters<typeof commitRecipeToMain>[0]> = {}) => commitRecipeToMain({ projectDir: repo, mainBranch: 'main', text, ...over });
  /** Everything a refusal must leave alone */
  const state = () => ({ main: git('rev-parse', 'main'), head: git('rev-parse', 'HEAD'), status: git('status', '--porcelain'), branch: git('rev-parse', '--abbrev-ref', 'HEAD') });
  const leftovers = () => ({ branch: git('branch', '--list', RECIPE_BRANCH), index: readdirSync(join(repo, '.git')).filter((name) => /recipe/i.test(name)) });

  beforeEach(() => init());

  it('reads main\'s preview.json, and says null when main has none', async () => {
    expect(await mainRecipeText(repo, 'main')).toBeNull();
    writeFileSync(join(repo, 'preview.json'), TEXT);
    git('add', '-A');
    git('commit', '-q', '-m', 'recipe');
    expect(await mainRecipeText(repo, 'main')).toBe(TEXT);
  });

  it('commits a new preview.json into main, and leaves nothing of its own behind', async () => {
    expect(await commit(TEXT)).toEqual({ status: 'merged' });
    expect(git('show', 'main:preview.json') + '\n').toBe(TEXT);
    expect(readFileSync(join(repo, 'preview.json'), 'utf-8')).toBe(TEXT);
    expect(git('log', '-1', '--format=%s')).toBe('Preview recipe: preview.json');
    // One commit on top of main, not a commit and a merge of it
    expect(git('rev-list', '--count', 'main')).toBe('2');
    expect(git('log', '-1', '--format=%P').split(' ')).toHaveLength(1);
    expect(git('status', '--porcelain')).toBe('');
    expect(leftovers()).toEqual({ branch: '', index: [] });
  });

  it('replaces the preview.json main has, with the message it is given', async () => {
    await commit(TEXT);
    expect(await commit(OTHER, { message: 'Preview recipe: the services' })).toEqual({ status: 'merged' });
    expect(await mainRecipeText(repo, 'main')).toBe(OTHER);
    expect(git('log', '-1', '--format=%s')).toBe('Preview recipe: the services');
  });

  it('makes no commit when main already has that text', async () => {
    await commit(TEXT);
    const before = git('rev-parse', 'main');
    expect(await commit(TEXT)).toEqual({ status: 'up_to_date' });
    expect(git('rev-parse', 'main')).toBe(before);
  });

  it("keeps the owner's unrelated uncommitted change, and still commits", async () => {
    writeFileSync(join(repo, 'shared.txt'), 'one\nmine\n');
    expect((await commit(TEXT)).status).toBe('merged');
    expect(readFileSync(join(repo, 'shared.txt'), 'utf-8')).toBe('one\nmine\n');
    expect(git('status', '--porcelain')).toBe('M shared.txt');
    expect(await mainRecipeText(repo, 'main')).toBe(TEXT);
  });

  it('refuses, and changes nothing, while the project is on another branch', async () => {
    git('checkout', '-q', '-b', 'feature');
    const before = state();
    const result = await commit(TEXT);
    expect(result.status).toBe('refused');
    expect(result.message).toBe('The project\'s folder is on "feature". The recipe goes into "main" once the folder is back on it.');
    expect(saidFor([result.message])).toMatchObject([{ key: 'recipeOtherBranch', params: { current: 'feature', main: 'main' } }]);
    expect(state()).toEqual(before);
    expect(leftovers()).toEqual({ branch: '', index: [] });
  });

  it("refuses, and changes nothing, while the owner has a preview.json of their own in the way", async () => {
    writeFileSync(join(repo, 'preview.json'), '{ "mine": true }\n');
    const before = state();
    const result = await commit(TEXT);
    expect(result.status).toBe('refused');
    expect(result.message).toBeTruthy();
    expect(state()).toEqual(before);
    expect(readFileSync(join(repo, 'preview.json'), 'utf-8')).toBe('{ "mine": true }\n');
    expect(leftovers()).toEqual({ branch: '', index: [] });
  });

  it('refuses, and changes nothing, in the middle of a merge', async () => {
    git('checkout', '-q', '-b', 'side');
    writeFileSync(join(repo, 'shared.txt'), 'side\n');
    git('commit', '-q', '-am', 'side');
    git('checkout', '-q', 'main');
    writeFileSync(join(repo, 'shared.txt'), 'main\n');
    git('commit', '-q', '-am', 'main');
    try {
      git('merge', 'side');
    } catch {
      // the conflict this test needs
    }
    const before = state();
    const result = await commit(TEXT);
    expect(result.status).toBe('refused');
    expect(saidFor([result.message])).toMatchObject([{ key: 'recipeMidMerge' }]);
    expect(state()).toEqual(before);
    expect(leftovers()).toEqual({ branch: '', index: [] });
  });

  it("leaves main alone when its preview.json is no longer the one the recipe was made against: a task's change came first", async () => {
    await commit(TEXT);
    const main = git('rev-parse', 'main');
    // Made against a main without the file; main has TEXT by now
    expect(await commit(OTHER, { expectedBase: 'none' })).toEqual({ status: 'replaced' });
    expect(git('rev-parse', 'main')).toBe(main);
    expect(await mainRecipeText(repo, 'main')).toBe(TEXT);
    // Made against what main has: it goes in
    expect(await commit(OTHER, { expectedBase: recipeHash(TEXT) })).toEqual({ status: 'merged' });
  });

  it('says the folder is not a git repository when it is not one', async () => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'vtl-plain-')));
    const result = await commit(TEXT);
    expect(result.status).toBe('refused');
    expect(saidFor([result.message])).toMatchObject([{ key: 'recipeNoRepo' }]);
  });

  it('says so in its own words when the folder is on no branch at all', async () => {
    git('checkout', '-q', '--detach');
    const before = state();
    const result = await commit(TEXT);
    expect(result.status).toBe('refused');
    expect(saidFor([result.message])).toMatchObject([{ key: 'recipeDetached', params: { main: 'main' } }]);
    expect(state()).toEqual(before);
  });

  it("refuses rather than overwrite a preview.json of the owner's that git ignores", async () => {
    writeFileSync(join(repo, '.git', 'info', 'exclude'), 'preview.json\n');
    writeFileSync(join(repo, 'preview.json'), '{ "mine": true }\n');
    const before = state();
    const result = await commit(TEXT);
    expect(result.status).toBe('refused');
    expect(saidFor([result.message])).toMatchObject([{ key: 'recipeFileInTheWay' }]);
    expect(readFileSync(join(repo, 'preview.json'), 'utf-8')).toBe('{ "mine": true }\n');
    expect(state()).toEqual(before);
  });

  it('clears away what an attempt that died left behind, and leaves nothing of its own', async () => {
    git('update-ref', `refs/heads/${RECIPE_BRANCH}`, git('rev-parse', 'main'));
    writeFileSync(join(repo, '.git', 'vibe-teamlead-recipe-index'), 'left over');
    expect(await commit(TEXT)).toEqual({ status: 'merged' });
    expect(leftovers()).toEqual({ branch: '', index: [] });
  });

  it.skipIf(isWindowsHost)("signs the commit when the owner's git signs commits, and refuses with nothing changed when signing fails", async () => {
    const signer = join(repo, '.git', 'no-signer.sh');
    writeFileSync(signer, '#!/bin/sh\necho "signing is not possible here" >&2\nexit 1\n');
    chmodSync(signer, 0o755);
    git('config', 'commit.gpgsign', 'true');
    git('config', 'gpg.program', signer);
    const before = state();
    const result = await commit(TEXT);
    expect(result.status).toBe('refused');
    expect(result.message).toBeTruthy();
    expect(state()).toEqual(before);
    expect(leftovers()).toEqual({ branch: '', index: [] });
  });

  it('commits to the branch the project calls its main', async () => {
    init('master');
    expect(await commit(TEXT, { mainBranch: 'master' })).toEqual({ status: 'merged' });
    expect(await mainRecipeText(repo, 'master')).toBe(TEXT);
  });

  it('refuses in words when the main branch is not there', async () => {
    const result = await commit(TEXT, { mainBranch: 'trunk' });
    expect(result.status).toBe('refused');
    expect(result.message).toBeTruthy();
    expect(leftovers()).toEqual({ branch: '', index: [] });
  });

  it('commits for an owner who has no git identity', async () => {
    init('main', false);
    const home = mkdtempSync(join(tmpdir(), 'vtl-home-'));
    const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'none') };
    for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete (env as Record<string, string | undefined>)[name];
    expect(await commit(TEXT, { env })).toEqual({ status: 'merged' });
    expect(git('log', '-1', '--format=%an <%ae>', 'main')).toBe('Vibe Teamlead <vibe-teamlead@localhost>');
  });

  it.skipIf(isWindowsHost)("runs none of the repository's hooks", async () => {
    const hooks = join(repo, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    for (const name of ['pre-merge-commit', 'post-merge', 'pre-commit', 'post-commit', 'reference-transaction']) {
      writeFileSync(join(hooks, name), `#!/bin/sh\necho ran > "${join(repo, 'hook-ran')}"\n`);
      chmodSync(join(hooks, name), 0o755);
    }
    expect((await commit(TEXT)).status).toBe('merged');
    expect(existsSync(join(repo, 'hook-ran'))).toBe(false);
  });
});
