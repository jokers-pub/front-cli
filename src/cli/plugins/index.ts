import type { ResolvedConfig } from "../config";
import { Plugin } from "../plugin";
import { htmlBuildPlugin, htmlInlineProxyPlugin } from "./html";
import { resolvePlugin } from "./resolve";
import { resolveDepBuildPlugin, resolveDepPlugin } from "./resolveDep";
import { metadataPlugin } from "./metadata";
import { assetPlugin } from "./asset";
import { esbuildBuildPlugin, esbuildPlugin } from "./esbuild";
import { importAnalysisPlugin } from "./importAnalysis";
import { clientInjectPlugin } from "./clientInject";
import { jsonPlugin } from "./json";
import { cssPlugin, cssPostPlugin } from "./css";
import { jokerPlugin } from "./joker/index";
import { definePlugin } from "./define";
import { dataURIPlugin } from "./dataUri";
import { importAnalysisBuildPlugin } from "./importAnalysisBuild";
import { loadFallbackPlugin } from "./loadFallback";
import { buildReporterPlugin } from "./reporter";
import { terserPlugin } from "./terser";
import { manualChunksPlugin } from "./manualChunks";
import { wokerPlugin } from "./worker";
import { workerImportMetaUrlPlugin } from "./workerImportMetaUrl";
export async function integrationPlugins(
    config: ResolvedConfig,
    sortPluginResult: {
        pre: Plugin[];
        normal: Plugin[];
        post: Plugin[];
    }
): Promise<Plugin[]> {
    //注意：config 类型在此是part
    return [
        metadataPlugin(),

        ...sortPluginResult.pre,

        config.command === "server"
            ? [clientInjectPlugin(config), resolveDepPlugin(config)]
            : [resolveDepBuildPlugin(config)],

        resolvePlugin(
            {
                ...config.resolve,
                asSrc: true
            },
            config as ResolvedConfig
        ),
        htmlInlineProxyPlugin(config),
        config.esbuild ? esbuildPlugin(config) : undefined,
        cssPlugin(config),
        jsonPlugin(),
        wokerPlugin(config),
        assetPlugin(config),
        jokerPlugin(config),
        workerImportMetaUrlPlugin(config),
        ...sortPluginResult.normal,
        definePlugin(config),
        config.command === "build" ? [htmlBuildPlugin(config)] : undefined,
        cssPostPlugin(config),

        ...sortPluginResult.post,
        config.command === "server"
            ? [importAnalysisPlugin(config)]
            : [
                  dataURIPlugin(),
                  ...((config.build.rollupOptions.plugins || []) as Plugin[]),
                  importAnalysisBuildPlugin(config),
                  config.esbuild ? esbuildBuildPlugin(config) : undefined,
                  manualChunksPlugin(config),
                  //多线程（含强制）
                  config.build.minify ? terserPlugin(config) : undefined,
                  buildReporterPlugin(config),

                  loadFallbackPlugin()
              ]
    ]
        .flat()
        .filter(Boolean) as Plugin[];
}
