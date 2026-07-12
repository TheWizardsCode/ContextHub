// Utility helpers for normalizing arguments passed to commander action handlers.
// Aim: make in-process (runInProcess) and spawned CLI runs behave the same
// when commander may pass a Command instance as the trailing argument.

type Primitive = string | number | boolean | bigint | null;

function isPrimitive(v: unknown): v is Primitive {
  return v === null || ["string", "number", "boolean", "bigint"].includes(typeof v);
}

export interface NormalizedArgs {
  ids: string[];
  // options contains only own-property keys whose values are primitives or null
  options: Record<string, Primitive>;
  // set of keys that were provided (own properties on parsed options)
  provided: Set<string>;
}

/**
 * Normalize arguments forwarded to a commander action handler.
 *
 * Behaviour:
 * - Detects if the last argument is a Commander Command instance (has .opts())
 *   and calls .opts() to obtain the parsed options.
 * - Accepts either variadic id args (e.g. 'id1', 'id2') or a single array arg
 *   containing ids (e.g. ['id1','id2']).
 * - Filters ids to only include primitive values (string|number|bigint) and
 *   coerces them to strings. This prevents Command instances or other objects
 *   from being treated as ids by the in-process harness.
 * - Filters options to only include own properties whose values are primitives
 *   (string/number/boolean/bigint) or null. This avoids reading prototype
 *   or instance properties like Command.parent.
 */
export function normalizeActionArgs(rawArgs: any[], knownOptionKeys?: string[]): NormalizedArgs {
  const args = Array.isArray(rawArgs) ? rawArgs.slice() : [];

  // Remove any trailing non-array object arguments (Commander may append
  // one or more objects such as a parsed options object and/or a
  // Command instance). Pop them off so they are not treated as positional
  // id candidates. Prefer the right-most object that exposes `.opts()` as
  // the source of parsed options; otherwise fall back to the first popped
  // plain object.
  let optsCandidate: any | undefined;
  while (args.length > 0) {
    const last = args[args.length - 1];
    if (!(last && typeof last === 'object' && !Array.isArray(last))) break;
    // pop trailing object so it won't be treated as an id
    args.pop();
    if (optsCandidate !== undefined) {
      // already have an options candidate from a more-right object; ignore
      continue;
    }
    if (typeof (last as any).opts === 'function') {
      try {
        optsCandidate = (last as any).opts();
      } catch {
        optsCandidate = last;
      }
    } else {
      optsCandidate = last;
    }
  }

  // Determine ids: either a single array arg, or the remaining variadic args
  let idCandidates: any[] = args;
  if (idCandidates.length === 1 && Array.isArray(idCandidates[0])) {
    idCandidates = idCandidates[0];
  }

  const ids: string[] = idCandidates
    .filter((v) => isPrimitive(v) && v !== null)
    .map((v) => String(v));

  const options: Record<string, Primitive> = {};
  const provided = new Set<string>();

  if (optsCandidate && typeof optsCandidate === 'object') {
    // iterate only own enumerable properties
    for (const key of Object.keys(optsCandidate)) {
      // If knownOptionKeys is provided, skip keys not in that list. This helps
      // avoid accidentally treating large objects (like parent) as options.
      if (knownOptionKeys && knownOptionKeys.length > 0 && !knownOptionKeys.includes(key)) {
        continue;
      }
      const val = (optsCandidate as any)[key];
      if (isPrimitive(val)) {
        options[key] = val;
        provided.add(key);
      }
    }
  }

  return { ids, options, provided };
}

/**
 * Convenience: check whether an option was explicitly provided by the user.
 */
export function optionWasProvided(normalized: NormalizedArgs, key: string): boolean {
  return normalized.provided.has(key);
}
