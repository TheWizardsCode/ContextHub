/**
 * Main entry point for the Worklog API server
 */

import { WorklogDatabase } from './database.js';
import { createAPI } from './api.js';
import { loadConfig } from './config.js';
import { DEFAULT_GIT_REMOTE, DEFAULT_GIT_BRANCH } from './sync-defaults.js';
import { getRemoteDataFileContent, gitPushDataFileToBranch, mergeWorkItems, mergeComments, mergeDependencyEdges, GitTarget } from './sync.js';
import { importFromJsonlContent, exportToJsonlAsync, getDefaultDataPath } from './jsonl.js';

const PORT = process.env.PORT || 3000;

// Load configuration and create database instance with prefix
const config = loadConfig();
const prefix = config?.prefix || 'WI';
const autoSync = config?.autoSync === true;
const gitRemote = config?.syncRemote || DEFAULT_GIT_REMOTE;
const gitBranch = config?.syncBranch || DEFAULT_GIT_BRANCH;
const dataPath = getDefaultDataPath();

const syncState = {
  timer: null as NodeJS.Timeout | null,
  inFlight: false,
  pending: false,
};

let isShuttingDown = false;

const AUTO_SYNC_DEBOUNCE_MS = 500;

async function performServerSync(): Promise<void> {
  if (syncState.inFlight) {
    syncState.pending = true;
    return;
  }

  syncState.inFlight = true;
  const gitTarget: GitTarget = {
    remote: gitRemote,
    branch: gitBranch,
  };

  try {
    const remoteContent = await getRemoteDataFileContent(dataPath, gitTarget);
    const remoteData = remoteContent ? importFromJsonlContent(remoteContent) : { items: [], comments: [], dependencyEdges: [] };
    const localItems = db.getAll();
    const localComments = db.getAllComments();
    const localEdges = db.getAllDependencyEdges();

    const itemMergeResult = mergeWorkItems(localItems, remoteData.items);
    const commentMergeResult = mergeComments(localComments, remoteData.comments);
    const edgeMergeResult = mergeDependencyEdges(localEdges, remoteData.dependencyEdges || []);

    const originalAutoSync = autoSync;
    if (originalAutoSync) {
      db.setAutoSync(false);
    }
    // SAFETY: db.import() is destructive (clears all items before inserting).
    // This is safe here because itemMergeResult.merged is the complete merged
    // set of local + remote items — no data is lost.
    db.import(itemMergeResult.merged, edgeMergeResult.merged);
    db.importComments(commentMergeResult.merged);
    if (originalAutoSync) {
      db.setAutoSync(true, () => {
        scheduleServerSync();
        return Promise.resolve();
      });
    }
    await exportToJsonlAsync(itemMergeResult.merged, commentMergeResult.merged, dataPath, edgeMergeResult.merged);

    await gitPushDataFileToBranch(dataPath, 'Sync work items and comments', gitTarget);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Auto-sync failed: ${message}`);
  } finally {
    syncState.inFlight = false;
    if (syncState.pending) {
      if (isShuttingDown) {
        return;
      }
      syncState.pending = false;
      scheduleServerSync();
    }
  }
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function flushServerSync(): Promise<void> {
  if (!autoSync) {
    return;
  }

  if (syncState.timer) {
    clearTimeout(syncState.timer);
    syncState.timer = null;
    syncState.pending = true;
  }

  while (syncState.pending || syncState.inFlight) {
    if (syncState.pending && !syncState.inFlight) {
      syncState.pending = false;
      await performServerSync();
      continue;
    }
    await wait(25);
  }
}

function scheduleServerSync(): void {
  if (!autoSync || isShuttingDown) {
    return;
  }
  if (syncState.timer) {
    clearTimeout(syncState.timer);
  }
  syncState.timer = setTimeout(() => {
    syncState.timer = null;
    void performServerSync();
  }, AUTO_SYNC_DEBOUNCE_MS);
}

// Create database instance - it will automatically:
// 1. Connect to persistent SQLite storage
// 2. Check if JSONL is newer than DB and refresh if needed
const db = new WorklogDatabase(prefix, undefined, undefined, false, autoSync, () => {
  scheduleServerSync();
  return Promise.resolve();
});

if (config) {
  console.log(`Using project: ${config.projectName} (prefix: ${config.prefix})`);
} else {
  console.log('No configuration found. Using default prefix: WI');
  console.log('Run "npm run cli -- init" to set up your project.');
}

console.log(`Database ready with ${db.getAll().length} work items and ${db.getAllComments().length} comments`);

// Create and start the API server
const app = createAPI(db);
const server = app.listen(PORT, () => {
  console.log(`Worklog API server running on http://localhost:${PORT}`);
});

async function shutdownServer(signal: NodeJS.Signals): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  console.log(`Received ${signal}; flushing pending exports before shutdown...`);

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

  if (autoSync) {
    syncState.pending = true;
  }

  try {
    await flushServerSync();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to flush pending exports: ${message}`);
  }

  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdownServer('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdownServer('SIGTERM');
});
