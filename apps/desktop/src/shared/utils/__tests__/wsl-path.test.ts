import { describe, expect, it } from 'vitest';
import { isWslPath } from '../wsl-path';

describe('isWslPath', () => {
  it('recognises the WSL shares, in any case and with either slash', () => {
    for (const p of [
      '\\\\wsl$\\Ubuntu\\home\\me\\app',
      '\\\\wsl.localhost\\Ubuntu\\home\\me\\app',
      '\\\\WSL$\\Ubuntu',
      '\\\\WSL.LocalHost\\Debian\\srv',
      '//wsl$/Ubuntu/home/me',
      '//wsl.localhost/Ubuntu/home/me',
      '\\\\wsl.localhost/Ubuntu/home',
      '\\\\?\\UNC\\wsl$\\Ubuntu\\home',
    ]) {
      expect(isWslPath(p), p).toBe(true);
    }
  });

  it('leaves Windows drives, other network shares and Mac paths alone', () => {
    for (const p of ['C:\\Users\\me\\wsl$', 'D:\\code\\app', '\\\\server\\share\\app', '\\\\wslx\\Ubuntu', '/home/me/wsl$/x', '/Users/me/app', '']) {
      expect(isWslPath(p), p).toBe(false);
    }
  });
});
