import { execAsync } from './cli-helpers.js';
import * as path from 'path';

// Initialize a lightweight git repo with an empty commit. Uses quiet flags
// and a single command to reduce process startup and filesystem I/O.
export async function initRepo(dir: string): Promise<void> {
  await execAsync('git init -q', { cwd: dir });
  // Configure user and create an empty commit (fast, no file I/O)
  await execAsync('git config user.email "test@example.com" && git config user.name "Test User" && git commit --allow-empty -m "init" -q', { cwd: dir });
}

export async function initBareRepo(dir: string): Promise<void> {
  await execAsync('git init --bare -q', { cwd: dir });
}

