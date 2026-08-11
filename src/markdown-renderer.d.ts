/**
 * Markdown renderer for CLI output.
 *
 * Renders a small subset of markdown (headers, lists, inline code, code
 * fences, links) into ANSI-colored output using chalk directly.
 *
 * Replaces the previous blessed-style tag renderer. The API signature
 * (renderMarkdownToTags, RendererOptions) is preserved for backward
 * compatibility even though the name "ToTags" is a misnomer — the output
 * is actually chalk ANSI strings.
 */
export interface RendererOptions {
    maxSize?: number;
}
export declare function renderMarkdownToTags(input: string, opts?: RendererOptions): string;
export default renderMarkdownToTags;
//# sourceMappingURL=markdown-renderer.d.ts.map