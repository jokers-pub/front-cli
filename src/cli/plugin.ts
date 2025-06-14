import type { CustomPluginOptions, Plugin as RollupPlugin, PluginContext, ResolveIdResult } from "rollup";
import { Config, ResolvedConfig } from "./config";
import { Server } from "./server";
import { HMRContext } from "./server/hmr";
import { ModuleNode } from "./server/moduleMap";
import { IndexHtmlTransform } from "./utils/html";
export interface Plugin extends RollupPlugin {
    /**
     * Execution order
     * - pre: Execute before core processing
     * - post: Execute after core processing
     */
    enforce?: "pre" | "post";

    /**
     * Specify execution context. Empty means all contexts.
     */
    apply?: Config["command"] | "all";

    /**
     * Hook for configuring the development server
     */
    configureServer?: (server: Server) => void | Promise<void>;

    /**
     * Transform configuration before processing
     */
    configTransform?: (config: ResolvedConfig) => Promise<void> | void;

    /**
     * Transform index.html before serving
     * Use this hook to inject scripts, modify meta tags, etc.
     */
    indexHtmlTransform?: IndexHtmlTransform;

    /**
     * Extend Rollup's resolveId hook with additional scanning options
     */
    resolveId?: (
        this: PluginContext,
        source: string,
        importer: string | undefined,
        options: { custom?: CustomPluginOptions; isEntry: boolean; scan?: boolean }
    ) => Promise<ResolveIdResult> | ResolveIdResult;

    /**
     * HMR update handler
     * Modify module graph or perform custom updates during hot reload
     */
    hmrUpdate?(ctx: HMRContext, server: Server): ModuleNode[] | void | Promise<ModuleNode[] | void>;
}

export function sortPlugins(plugins: Plugin[]) {
    let result: { pre: Plugin[]; normal: Plugin[]; post: Plugin[] } = {
        pre: [],
        normal: [],
        post: []
    };

    plugins.forEach((p) => {
        switch (p.enforce) {
            case "pre":
                result.pre.push(p);
                break;
            case "post":
                result.post.push(p);
                break;
            default:
                result.normal.push(p);
                break;
        }
    });

    return result;
}
