export interface PagerOptions {
    noPager?: boolean;
    forcePager?: boolean;
    pager?: string | null;
}
/**
 * Write text to stdout or pipe it through a pager when appropriate.
 * - Respects noPager flag
 * - Only uses pager in interactive TTYs
 * - Respects $PAGER or uses `less -R` fallback
 * - Falls back to plain stdout if pager fails
 */
export default function pageOutput(text: string, opts?: PagerOptions): void;
//# sourceMappingURL=pager.d.ts.map