import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { ArtifactStore } from './contracts.js';

async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

export function createFilesystemArtifacts(rootDir: string): ArtifactStore {
  const root = resolve(rootDir);

  return {
    root,
    async writeJson(path, payload) {
      const target = resolve(root, path);
      await ensureParent(target);
      await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      return target;
    },
    async writeText(path, text) {
      const target = resolve(root, path);
      await ensureParent(target);
      await writeFile(target, text, 'utf8');
      return target;
    },
  };
}
