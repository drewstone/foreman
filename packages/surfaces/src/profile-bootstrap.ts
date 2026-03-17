import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createMemoryStore } from '@drew/foreman-memory';
import {
  bootstrapProfileFromSources,
  FilesystemProfileStore,
  type ProfileBootstrapInput,
} from '@drew/foreman-profiles';

export interface ProfileBootstrapRunOptions extends ProfileBootstrapInput {
  profileRoot: string;
  memoryRoot?: string;
}

export interface ProfileBootstrapRunResult {
  profileId: string;
  profilePath: string;
  memoryRoot: string;
  summary: string;
}

export async function runProfileBootstrap(
  options: ProfileBootstrapRunOptions,
): Promise<ProfileBootstrapRunResult> {
  const profileRoot = resolve(options.profileRoot);
  const memoryRoot = resolve(options.memoryRoot ?? join(profileRoot, '..', 'memory'));

  await mkdir(profileRoot, { recursive: true });
  await mkdir(memoryRoot, { recursive: true });

  const profileStore = new FilesystemProfileStore(profileRoot);
  const memoryStore = await createMemoryStore({
    rootDir: memoryRoot,
  });
  const result = await bootstrapProfileFromSources(options);

  await profileStore.put(result.profileRecord);
  await memoryStore.putProfileMemory(result.profileMemory);
  if (result.userMemory) {
    await memoryStore.putUserMemory(result.userMemory);
  }

  return {
    profileId: result.profileRecord.profile.id,
    profilePath: join(profileRoot, `${sanitize(result.profileRecord.profile.id)}.json`),
    memoryRoot,
    summary: result.summary,
  };
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}
