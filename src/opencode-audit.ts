import { spawn, type ChildProcess } from 'child_process';

const DEFAULT_TIMEOUT_MS = 180_000;
const FORCE_KILL_AFTER_MS = 1_500;

type OpencodeJsonEvent = {
  type?: unknown;
  event?: unknown;
  part?: {
    type?: unknown;
    text?: unknown;
    content?: unknown;
    messageID?: unknown;
  };
  question?: unknown;
  input?: unknown;
};

export interface RunOpencodeAuditOptions {
  workItemId: string;
  cwd?: string;
  timeoutMs?: number;
  opencodeBin?: string;
  spawnImpl?: typeof spawn;
  signal?: AbortSignal;
  onSpawn?: (child: ChildProcess) => void;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export interface RunOpencodeAuditResult {
  auditText: string;
  terminatedOnWait: boolean;
  exitCode: number;
  /**
   * Structured parts for the selected message (if available).
   * Each part includes the text and an optional part type (eg. 'text', 'tool-result').
   */
  selectedMessageParts?: Array<{ text: string; type?: string }>;
}

const normalizeEventLabel = (value: string): string => value.toLowerCase().replace(/[\s._-]+/g, ' ').trim();

const toStringValue = (value: unknown): string | null => {
  if (typeof value === 'string') return value;
  return null;
};

const pushLabel = (labels: Set<string>, value: unknown): void => {
  const text = toStringValue(value);
  if (!text) return;
  labels.add(normalizeEventLabel(text));
};

export function resolveOpencodeBinary(explicit?: string): string {
  if (explicit && explicit.trim() !== '') return explicit.trim();
  if (process.env.WL_OPENCODE_BIN && process.env.WL_OPENCODE_BIN.trim() !== '') {
    return process.env.WL_OPENCODE_BIN.trim();
  }
  return 'opencode';
}

export function isWaitingForInputEvent(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false;

  const parsed = event as OpencodeJsonEvent;
  const labels = new Set<string>();
  pushLabel(labels, parsed.type);
  pushLabel(labels, parsed.event);
  pushLabel(labels, parsed.part?.type);

  const has = (token: string) => {
    for (const label of labels) {
      if (label.includes(token)) return true;
    }
    return false;
  };

  if (has('waiting for input')) return true;
  if ((has('question') && (has('asked') || has('request'))) || parsed.question !== undefined) return true;
  if ((has('input') && has('request')) || parsed.input !== undefined) return true;
  if (has('permission') && has('request')) return true;

  return false;
}

const extractTextPayload = (event: OpencodeJsonEvent): { messageId: string; text: string; partType?: string } | null => {
  const part = event.part;
  // Prefer explicit text, fall back to content (tool results often use `content`).
  const text = toStringValue(part?.text ?? part?.content);
  if (!text) return null;

  const eventType = normalizeEventLabel(toStringValue(event.type) || '');
  const partType = normalizeEventLabel(toStringValue(part?.type) || '');

  // Accept textual parts or tool-result parts. Preserve compatibility with
  // older logic by allowing events with empty or 'text' event types.
  if (eventType !== '' && eventType !== 'text' && !partType.includes('text') && !partType.includes('tool')) {
    return null;
  }

  const messageId = toStringValue(part?.messageID) || '__default__';
  return { messageId, text, partType };
};

const pushUniquePart = (target: Array<{ text: string; type?: string }>, text: string, type?: string): void => {
  if (target.length === 0 || target[target.length - 1].text !== text) {
    target.push({ text, type });
  }
};

const selectAuditMessageParts = (
  textsByMessage: Map<string, Array<{ text: string; type?: string }>>,
  messageOrder: string[],
): { text: string; parts: Array<{ text: string; type?: string }> } => {
  for (let i = messageOrder.length - 1; i >= 0; i -= 1) {
    const messageId = messageOrder[i];
    const chunks = textsByMessage.get(messageId) || [];
    const candidate = chunks.map(c => c.text).join('\n').trim();
    if (candidate !== '') return { text: candidate, parts: chunks };
  }

  for (const chunks of textsByMessage.values()) {
    const candidate = chunks.map(c => c.text).join('\n').trim();
    if (candidate !== '') return { text: candidate, parts: chunks };
  }

  return { text: '', parts: [] };
};

const formatSpawnError = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
};

export async function runOpencodeAudit(options: RunOpencodeAuditOptions): Promise<RunOpencodeAuditResult> {
  const workItemId = options.workItemId?.trim();
  if (!workItemId) {
    throw new Error('workItemId is required for audit execution.');
  }

  const spawnImpl = options.spawnImpl ?? spawn;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const opencodeBin = resolveOpencodeBinary(options.opencodeBin);

  const child = spawnImpl(opencodeBin, ['run', '--format', 'json', `audit ${workItemId}`], {
    cwd: options.cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  options.onSpawn?.(child);

  let stdoutBuffer = '';
  let stderrBuffer = '';

  const parseErrors: string[] = [];
  const stderrLines: string[] = [];
  const textsByMessage = new Map<string, Array<{ text: string; type?: string }>>();
  const messageOrder: string[] = [];

  let terminatedOnWait = false;
  let timeoutTriggered = false;
  let aborted = false;
  let closed = false;

  let timeoutTimer: NodeJS.Timeout | null = null;
  let forceKillTimer: NodeJS.Timeout | null = null;

  const requestStop = () => {
    if (closed) return;
    try {
      child.kill('SIGTERM');
    } catch {
      return;
    }
    // If we're explicitly requesting stop (for example because we've seen
    // a waiting-for-input event), cancel the global timeout so it doesn't
    // race and mark the operation as a hard timeout after we've already
    // begun a graceful shutdown.
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }

    if (!forceKillTimer) {
      forceKillTimer = setTimeout(() => {
        if (closed) return;
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, FORCE_KILL_AFTER_MS);
    }
  };

  const cleanupTimers = () => {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
  };

  const consumeStdoutLine = (line: string) => {
    if (line.trim() === '') return;
    options.onStdoutLine?.(line);

    let event: OpencodeJsonEvent;
    try {
      event = JSON.parse(line) as OpencodeJsonEvent;
    } catch {
      parseErrors.push(line);
      return;
    }

    if (isWaitingForInputEvent(event)) {
      terminatedOnWait = true;
      requestStop();
    }

    const textPayload = extractTextPayload(event);
    if (!textPayload) return;

    const { messageId, text, partType } = textPayload;
    if (!textsByMessage.has(messageId)) {
      textsByMessage.set(messageId, []);
      messageOrder.push(messageId);
    }
    const chunks = textsByMessage.get(messageId)!;
    pushUniquePart(chunks, text, partType || undefined);
  };

  const flushStdoutBuffer = () => {
    const line = stdoutBuffer.trim();
    stdoutBuffer = '';
    if (line !== '') consumeStdoutLine(line);
  };

  const consumeStderrLine = (line: string) => {
    if (line.trim() === '') return;
    options.onStderrLine?.(line);
    stderrLines.push(line);
  };

  const flushStderrBuffer = () => {
    const line = stderrBuffer.trim();
    stderrBuffer = '';
    if (line !== '') consumeStderrLine(line);
  };

  child.stdout?.on('data', (chunk: Buffer | string) => {
    stdoutBuffer += chunk.toString();
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      consumeStdoutLine(line);
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderrBuffer += chunk.toString();
    let newlineIndex = stderrBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stderrBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
      consumeStderrLine(line);
      newlineIndex = stderrBuffer.indexOf('\n');
    }
  });

  const abortHandler = () => {
    aborted = true;
    requestStop();
  };

  if (options.signal) {
    if (options.signal.aborted) {
      abortHandler();
    } else {
      options.signal.addEventListener('abort', abortHandler, { once: true });
    }
  }

  if (timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      timeoutTriggered = true;
      requestStop();
    }, timeoutMs);
  }

  let closeCode: number | null = null;
  let closeSignal: NodeJS.Signals | null = null;

  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        closeCode = code;
        closeSignal = signal;
        resolve();
      });
    });
  } catch (error) {
    cleanupTimers();
    if (options.signal) {
      options.signal.removeEventListener('abort', abortHandler);
    }
    throw new Error(`Failed to start opencode audit process: ${formatSpawnError(error)}`);
  }

  closed = true;
  cleanupTimers();
  if (options.signal) {
    options.signal.removeEventListener('abort', abortHandler);
  }
  flushStdoutBuffer();
  flushStderrBuffer();

  if (aborted) {
    throw new Error('Audit command was cancelled.');
  }

  // If the timeout fired but we already detected a waiting-for-input
  // condition and initiated shutdown, prefer the waiting-for-input
  // outcome over treating this as an unexpected hard timeout. Only
  // surface the timeout as an error when we did not previously
  // terminate due to a waiting-for-input event.
  if (timeoutTriggered && !terminatedOnWait) {
    throw new Error(`Timed out after ${timeoutMs}ms while waiting for audit output.`);
  }

  if (parseErrors.length > 0) {
    const preview = parseErrors[0].slice(0, 200);
    throw new Error(`Failed to parse opencode JSON output. First invalid line: ${preview}`);
  }

  const selected = selectAuditMessageParts(textsByMessage, messageOrder);
  const auditText = selected.text;
  if (auditText === '') {
    throw new Error('Audit output did not include assistant text.');
  }

  const exitCode = typeof closeCode === 'number' ? closeCode : (closeSignal ? 1 : 0);
  if (exitCode !== 0 && !terminatedOnWait) {
    const stderr = stderrLines.join('\n').trim();
    const suffix = stderr ? ` Stderr: ${stderr}` : '';
    throw new Error(`Audit process exited with code ${exitCode}.${suffix}`);
  }

  return {
    auditText,
    terminatedOnWait,
    exitCode,
    selectedMessageParts: selected.parts,
  };
}
