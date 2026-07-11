import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execAsync, enterTempDir, leaveTempDir, writeConfig, writeInitSemaphore, cliPath } from './cli-helpers.js';
import * as fs from 'fs';

describe('comment add/update with --comment-file', () => {
  let tempState: { tempDir: string; originalCwd: string };
  let workItemId: string;

  beforeEach(async () => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);

    // Create a work item to add comments to
    const { stdout } = await execAsync(`tsx ${cliPath} --json create -t "For comment-file tests"`);
    workItemId = JSON.parse(stdout).workItem.id;
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  it('comment add should read comment from file', async () => {
    const commentPath = './comment.txt';
    fs.writeFileSync(commentPath, 'Comment from file', 'utf8');

    const { stdout } = await execAsync(`tsx ${cliPath} --json comment add ${workItemId} --comment-file ${commentPath} --author tester`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.comment.comment).toBe('Comment from file');
    expect(result.comment.author).toBe('tester');
  });

  it('comment add should fail when --comment-file combined with --comment', async () => {
    const commentPath = './comment.txt';
    fs.writeFileSync(commentPath, 'File content', 'utf8');

    try {
      await execAsync(`tsx ${cliPath} --json comment add ${workItemId} --comment-file ${commentPath} --comment "inline" --author tester`);
      // Should not reach here
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.stderr).toContain('--comment-file');
      expect(e.exitCode).not.toBe(0);
    }
  });

  it('comment add should fail when --comment-file combined with --body', async () => {
    const commentPath = './comment.txt';
    fs.writeFileSync(commentPath, 'File content', 'utf8');

    try {
      await execAsync(`tsx ${cliPath} --json comment add ${workItemId} --comment-file ${commentPath} --body "inline" --author tester`);
      // Should not reach here
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.stderr).toContain('--comment-file');
      expect(e.exitCode).not.toBe(0);
    }
  });

  it('comment add should fail with clear error for missing file', async () => {
    try {
      await execAsync(`tsx ${cliPath} --json comment add ${workItemId} --comment-file ./nonexistent.txt --author tester`);
      // Should not reach here
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.stderr).toContain('nonexistent');
      expect(e.exitCode).not.toBe(0);
    }
  });

  it('comment update should read comment from file', async () => {
    // First create a comment
    const createOut = await execAsync(`tsx ${cliPath} --json comment add ${workItemId} --comment "Initial" --author tester`);
    const created = JSON.parse(createOut.stdout);
    const commentId = created.comment.id;

    // Now update it from a file
    const updatePath = './update-comment.txt';
    fs.writeFileSync(updatePath, 'Updated from file', 'utf8');

    const { stdout } = await execAsync(`tsx ${cliPath} --json comment update ${commentId} --comment-file ${updatePath}`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.comment.comment).toBe('Updated from file');
  });

  it('should handle content close to 64KB', async () => {
    const largeContent = 'A'.repeat(64000);
    const commentPath = './large-comment.txt';
    fs.writeFileSync(commentPath, largeContent, 'utf8');

    const { stdout } = await execAsync(`tsx ${cliPath} --json comment add ${workItemId} --comment-file ${commentPath} --author tester`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.comment.comment).toBe(largeContent);
    expect(result.comment.comment.length).toBe(64000);
  });

  it('should preserve UTF-8 content including emoji', async () => {
    const utf8Content = 'Hello 👋, こんにちは, ñoño, émôjì ö';
    const commentPath = './utf8-comment.txt';
    fs.writeFileSync(commentPath, utf8Content, 'utf8');

    const { stdout } = await execAsync(`tsx ${cliPath} --json comment add ${workItemId} --comment-file ${commentPath} --author tester`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.comment.comment).toBe(utf8Content);
  });
});
