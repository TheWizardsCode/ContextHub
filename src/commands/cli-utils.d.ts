type Primitive = string | number | boolean | bigint | null;
export interface NormalizedArgs {
    ids: string[];
    options: Record<string, Primitive>;
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
export declare function normalizeActionArgs(rawArgs: any[], knownOptionKeys?: string[]): NormalizedArgs;
/**
 * Convenience: check whether an option was explicitly provided by the user.
 */
export declare function optionWasProvided(normalized: NormalizedArgs, key: string): boolean;
export {};
//# sourceMappingURL=cli-utils.d.ts.map