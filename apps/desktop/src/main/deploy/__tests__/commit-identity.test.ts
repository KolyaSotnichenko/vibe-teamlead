import { describe, expect, it, vi } from 'vitest';
import { ensureCommitIdentity, isLinkableEmail, noreplyEmail, type CommitIdentityDeps } from '../commit-identity';

function deps(email: string | undefined, name: string | undefined): CommitIdentityDeps & { writes: Array<[string, string]> } {
  const writes: Array<[string, string]> = [];
  return {
    writes,
    readConfig: vi.fn(async (key: 'user.email' | 'user.name') => (key === 'user.email' ? email : name)),
    githubUser: vi.fn(async () => ({ id: 36386768, login: 'KolyaSotnichenko', name: 'Mykola Sotnichenko' })),
    writeLocalConfig: vi.fn(async (key: 'user.email' | 'user.name', value: string) => {
      writes.push([key, value]);
    }),
  };
}

describe('isLinkableEmail', () => {
  it('rejects what git makes up from the machine name, and an empty value', () => {
    for (const e of [undefined, '', 'nick@Mykolas-MacBook-Pro.local', 'vibe-teamlead@localhost', 'nick@host', 'not-an-email', 'a@b.localdomain']) {
      expect(isLinkableEmail(e)).toBe(false);
    }
  });
  it('accepts real addresses and GitHub noreply addresses', () => {
    for (const e of ['me@example.com', '36386768+KolyaSotnichenko@users.noreply.github.com']) expect(isLinkableEmail(e)).toBe(true);
  });
});

describe('ensureCommitIdentity', () => {
  it('no git email (git would sign as user@host): sets the GitHub noreply address in the project', async () => {
    const d = deps(undefined, 'Nick');
    const r = await ensureCommitIdentity(d);
    expect(r).toEqual({ changed: true, email: noreplyEmail(36386768, 'KolyaSotnichenko') });
    expect(d.writes).toEqual([['user.email', '36386768+KolyaSotnichenko@users.noreply.github.com']]);
  });

  it('a made-up machine address is replaced; a missing name becomes the GitHub name', async () => {
    const d = deps('nick@Mykolas-MacBook-Pro.local', undefined);
    await ensureCommitIdentity(d);
    expect(d.writes).toEqual([
      ['user.email', '36386768+KolyaSotnichenko@users.noreply.github.com'],
      ['user.name', 'Mykola Sotnichenko'],
    ]);
  });

  it("a real address the owner chose is left alone, and GitHub isn't asked", async () => {
    const d = deps('me@example.com', 'Nick');
    expect(await ensureCommitIdentity(d)).toEqual({ changed: false, email: 'me@example.com' });
    expect(d.writes).toEqual([]);
    expect(d.githubUser).not.toHaveBeenCalled();
  });

  it('no GitHub display name: the login is used', async () => {
    const d = deps(undefined, undefined);
    d.githubUser = vi.fn(async () => ({ id: 1, login: 'octo', name: null }));
    await ensureCommitIdentity(d);
    expect(d.writes).toContainEqual(['user.name', 'octo']);
  });
});
