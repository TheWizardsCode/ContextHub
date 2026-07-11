import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorklogDatabase } from '../src/database.js';

type BenchmarkOptions = {
  levelSize: number;
  depth: number;
  gap: number;
  autoExport: boolean;
  keepArtifacts: boolean;
  prefix: string;
};

const DEFAULTS: BenchmarkOptions = {
  levelSize: 1000,
  depth: 3,
  gap: 100,
  autoExport: false,
  keepArtifacts: false,
  prefix: 'BENCH',
};

const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;

const parseArgs = (argv: string[]): BenchmarkOptions => {
  const options = { ...DEFAULTS };
  const args = argv.slice(2);

  const readValue = (index: number): string | undefined => {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      return undefined;
    }
    return value;
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case '--level-size': {
        const value = readValue(i);
        if (value) options.levelSize = Number(value);
        break;
      }
      case '--depth': {
        const value = readValue(i);
        if (value) options.depth = Number(value);
        break;
      }
      case '--gap': {
        const value = readValue(i);
        if (value) options.gap = Number(value);
        break;
      }
      case '--auto-export': {
        options.autoExport = true;
        break;
      }
      case '--keep': {
        options.keepArtifacts = true;
        break;
      }
      case '--prefix': {
        const value = readValue(i);
        if (value) options.prefix = value;
        break;
      }
      default:
        break;
    }
  }

  return options;
};

const createTempPaths = () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-sort-index-bench-'));
  return {
    tempRoot,
    dbPath: path.join(tempRoot, 'worklog.db'),
    jsonlPath: path.join(tempRoot, 'worklog-data.jsonl'),
  };
};

const buildDataset = (db: WorklogDatabase, levelSize: number, depth: number): number => {
  let parents: string[] = [];
  let total = 0;

  for (let level = 0; level < depth; level += 1) {
    const currentLevel: string[] = [];
    for (let i = 0; i < levelSize; i += 1) {
      const priority = PRIORITIES[i % PRIORITIES.length];
      const parentId = level === 0 ? null : parents[i % parents.length];
      const item = db.create({
        title: `Bench L${level} #${i + 1}`,
        priority,
        status: 'open',
        parentId,
      });
      currentLevel.push(item.id);
      total += 1;
    }
    parents = currentLevel;
  }

  return total;
};

const formatNumber = (value: number): string => {
  return value.toLocaleString('en-US');
};

const run = () => {
  const options = parseArgs(process.argv);
  const { tempRoot, dbPath, jsonlPath } = createTempPaths();
  const db = new WorklogDatabase(options.prefix, dbPath, jsonlPath, options.autoExport, true);

  const totalItems = buildDataset(db, options.levelSize, options.depth);

  const start = process.hrtime.bigint();
  const result = db.assignSortIndexValues(options.gap);
  const end = process.hrtime.bigint();

  const durationMs = Number(end - start) / 1_000_000;
  const itemsPerSecond = durationMs > 0 ? (result.updated / (durationMs / 1000)) : 0;

  const summary = {
    levelSize: options.levelSize,
    depth: options.depth,
    totalItems,
    gap: options.gap,
    autoExport: options.autoExport,
    updatedItems: result.updated,
    durationMs: Math.round(durationMs * 100) / 100,
    itemsPerSecond: Math.round(itemsPerSecond * 100) / 100,
    dbPath,
    jsonlPath,
    timestamp: new Date().toISOString(),
    keepArtifacts: options.keepArtifacts,
  };

  console.log('Sort-index migration benchmark');
  console.log(`- levelSize: ${formatNumber(summary.levelSize)}`);
  console.log(`- depth: ${summary.depth}`);
  console.log(`- totalItems: ${formatNumber(summary.totalItems)}`);
  console.log(`- gap: ${summary.gap}`);
  console.log(`- autoExport: ${summary.autoExport}`);
  console.log(`- updatedItems: ${formatNumber(summary.updatedItems)}`);
  console.log(`- durationMs: ${summary.durationMs}`);
  console.log(`- itemsPerSecond: ${formatNumber(summary.itemsPerSecond)}`);
  console.log(`- dbPath: ${summary.dbPath}`);
  console.log(`- jsonlPath: ${summary.jsonlPath}`);
  console.log('---');
  console.log(JSON.stringify(summary));

  if (!options.keepArtifacts) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
};

run();
