import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cliSurfaceManifest, sdkWorkspaceExports } from './sync-manifest.js';

interface RootPackageJson {
  scripts?: Record<string, string>;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJsonPath = path.join(repoRoot, 'package.json');
const surfacesIndexPath = path.join(repoRoot, 'packages/surfaces/src/index.ts');
const sdkIndexPath = path.join(repoRoot, 'packages/sdk/src/index.ts');

const rootPackageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as RootPackageJson;
const rootScripts = rootPackageJson.scripts ?? {};
const surfacesIndex = readFileSync(surfacesIndexPath, 'utf8');
const sdkIndex = readFileSync(sdkIndexPath, 'utf8');

const errors: string[] = [];

for (const entry of cliSurfaceManifest) {
  const expectedCommand = `tsx ${entry.entrypoint}`;
  const actualCommand = rootScripts[entry.scriptName];

  if (actualCommand !== expectedCommand) {
    errors.push(
      `root script "${entry.scriptName}" is "${actualCommand ?? '<missing>'}" but expected "${expectedCommand}"`,
    );
  }

  const entrypointPath = path.join(repoRoot, entry.entrypoint);
  if (!existsSync(entrypointPath)) {
    errors.push(`CLI entrypoint missing: ${entry.entrypoint}`);
  }

  if (!surfacesIndex.includes(entry.exportName)) {
    errors.push(
      `surfaces index does not export "${entry.exportName}" required by CLI script "${entry.scriptName}"`,
    );
  }
}

for (const specifier of sdkWorkspaceExports) {
  const exportStatement = `export * from '${specifier}';`;
  if (!sdkIndex.includes(exportStatement)) {
    errors.push(`sdk index missing workspace export ${specifier}`);
  }
}

if (errors.length > 0) {
  console.error('Foreman sync check failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('Foreman sync check passed.');
