import { ResolvedConfig } from "../config";
import { Plugin } from "../plugin";
import { isCssRequest, isInNodeModules } from "../utils";
import { cleanUrl, logger } from "@joker.front/shared";
import { GetModuleInfo, ManualChunkMeta } from "rollup";

const LOGTAG = "Joker_manualChunks";

let staticImportedCache = new Map<string, boolean>();

export function manualChunksPlugin(config: ResolvedConfig): Plugin {
    let islib = config.build.lib;

    return {
        name: "joker:manualChunks",
        apply: "build",
        configTransform(config) {
            if (islib) return;
            staticImportedCache.clear();
            let outputs = config.build.rollupOptions.output;
            if (outputs) {
                outputs = Array.isArray(outputs) ? outputs : [outputs];

                for (let output of outputs) {
                    if (output.format !== "umd" && output.format !== "iife") {
                        if (output.manualChunks) {
                            if (typeof output.manualChunks === "function") {
                                let userManualChunks = output.manualChunks;

                                output.manualChunks = (id: string, api: ManualChunkMeta) => {
                                    //dep 逆变 id
                                    let depInfo = config.depHandler.getDepInfoFromFile(cleanUrl(id));
                                    if (depInfo) {
                                        id = depInfo.src || id;
                                    }
                                    return userManualChunks(id, api) ?? jokerManualChunks(id, api);
                                };
                            } else {
                                logger.warn(
                                    LOGTAG,
                                    `manualChunks is specified as an object type. Joker cannot perform fusion conversion safely. It is recommended to use a Function to configure this property to retain logic such as import() asynchronous file path output and vendor package splitting provided by Joker.`
                                );
                            }
                        } else {
                            output.manualChunks = jokerManualChunks;
                        }
                    }
                }
            } else {
                config.build.rollupOptions.output = {
                    manualChunks: jokerManualChunks
                };
            }
        }
    };
}

function jokerManualChunks(id: string, api: ManualChunkMeta) {
    //node_modules && 同步依赖 => vendor
    if (isInNodeModules(id) && !isCssRequest(id) && staticImportedByEntry(id, api.getModuleInfo, staticImportedCache)) {
        return "vendor";
    }
}

function staticImportedByEntry(
    id: string,
    getModuleInfo: GetModuleInfo,
    cache: Map<string, boolean>,
    importStack: string[] = []
): boolean {
    if (cache.has(id)) {
        return cache.get(id)!;
    }

    //循环引用
    if (importStack.includes(id)) {
        cache.set(id, false);
        return false;
    }

    let mod = getModuleInfo(id);

    if (!mod) {
        cache.set(id, false);
        return false;
    }

    if (mod.isEntry) {
        cache.set(id, true);
        return true;
    }

    let someImporterIs = mod.importers.some((importer) =>
        staticImportedByEntry(importer, getModuleInfo, cache, importStack.concat(id))
    );

    cache.set(id, someImporterIs);
    return someImporterIs;
}
