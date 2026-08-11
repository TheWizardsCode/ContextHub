/**
 * GitHub command - GitHub Issue sync commands (push and import)
 */
import type { PluginContext } from '../plugin-types.js';
export declare function resolveGithubConfig(options: {
    repo?: string;
    labelPrefix?: string;
}): {
    repo: string;
    labelPrefix: string;
};
export default function register(ctx: PluginContext): void;
//# sourceMappingURL=github.d.ts.map