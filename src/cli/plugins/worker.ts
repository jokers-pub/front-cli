import { rollup, EmittedAsset, OutputChunk } from "rollup";
import { ResolvedConfig } from "../config";
import { Plugin } from "../plugin";
import { addUrlQuery, getHash, parseRequest } from "../utils";
import { cleanUrl } from "@joker.front/shared";
import { createToImportMetaURLBasedRelativeRuntime, onRollupWarning, toOutputFilePath } from "../build";
import path from "path";
import { fileToUrl } from "./asset";
import MagicString from "magic-string";
import { terserPlugin } from "./terser";

export type WorkerType = "classic" | "module" | "ignore";
export const WORKER_FILE_ID = "worker_file";

export function isWorkerRequest(id: string): boolean {
    let query = parseRequest(id);

    if (query && query[WORKER_FILE_ID] !== undefined) return true;
    return false;
}
export const workerAssetUrlRE = /__JOKER_WORKER_ASSET__([a-z\d]{8})__/g;

export function wokerPlugin(config: ResolvedConfig): Plugin {
    return {
        name: "joker:worker",
        load(id) {
            if (config.command === "build") {
                let parsedQuery = parseRequest(id);

                if (parsedQuery && (parsedQuery.worker ?? parsedQuery.sharedworker) !== undefined) {
                    return "";
                }
            }
        },
        async transform(code, id) {
            let query = parseRequest(id);

            if (query && query[WORKER_FILE_ID]) {
                return {
                    code
                };
            }

            if (!query || ((query && query.worker) ?? query.sharedworker) === undefined) {
                return;
            }

            let url;
            let workerConstructor = query.sharedworker !== undefined ? "SharedWorker" : "Worker";
            let workerType = "module";
            let workerOptions = `{
                type: "module",
                name: options?.name
              }`;

            if (config.command === "build") {
                config.depHandler.registerWorkersSource(id);

                if (query.inline !== undefined) {
                    let chunk = await bundleWorkerEntry(config, id, query);
                    let encodedJs = `let encodedJs = "${Buffer.from(chunk.code).toString("base64")}";`;
                    let code =
                        // Using blob URL for SharedWorker results in multiple instances of a same worker
                        workerConstructor === "Worker"
                            ? `${encodedJs}
                  let decodeBase64 = (base64) => Uint8Array.from(atob(base64), c => c.charCodeAt(0));
                  let blob = typeof window !== "undefined" && window.Blob && new Blob([${
                      workerType === "classic"
                          ? ""
                          : // `URL` is always available, in `Worker[type="module"]`
                            `'URL.revokeObjectURL(import.meta.url);',`
                  }decodeBase64(encodedJs)], { type: "text/javascript;charset=utf-8" });
                  export default function WorkerWrapper(options) {
                    let objURL;
                    try {
                      objURL = blob && (window.URL || window.webkitURL).createObjectURL(blob);
                      if (!objURL) throw ''
                      let worker = new ${workerConstructor}(objURL, ${workerOptions});
                      worker.addEventListener("error", () => {
                        (window.URL || window.webkitURL).revokeObjectURL(objURL);
                      });
                      return worker;
                    } catch(e) {
                      return new ${workerConstructor}(
                        "data:text/javascript;base64," + encodedJs,
                        ${workerOptions}
                      );
                    }${
                        // For module workers, we should not revoke the URL until the worker runs,
                        // otherwise the worker fails to run
                        workerType === "classic"
                            ? ` finally {
                            objURL && (window.URL || window.webkitURL).revokeObjectURL(objURL);
                          }`
                            : ""
                    }
                  }`
                            : `${encodedJs}
                  export default function WorkerWrapper(options) {
                    return new ${workerConstructor}(
                      "data:text/javascript;base64," + encodedJs,
                      ${workerOptions}
                    );
                  }
                  `;
                    return {
                        code,
                        // Empty sourcemap to suppress Rollup warning
                        map: { mappings: "" }
                    };
                } else {
                    url = await workerFileToUrl(config, id);
                }
            } else {
                url = await fileToUrl(cleanUrl(id), config, this);
                url = addUrlQuery(url, `${WORKER_FILE_ID}&type=${workerType}`);
            }

            let urlCode = JSON.stringify(url);
            if (query.url !== undefined) {
                return {
                    code: `export default ${urlCode}`,
                    map: { mappings: "" }
                };
            }

            return {
                code: `export default function WorkerWrapper(options) {
                  return new ${workerConstructor}(
                    ${urlCode},
                    ${workerOptions}
                  );
                }`,
                map: { mappings: "" }
            };
        },
        renderChunk(code, chunk, outputOptions) {
            let s: MagicString;

            let result = () => {
                if (s) {
                    return {
                        code: s.toString(),
                        map: config.build.sourcemap ? s.generateMap({ hires: true }) : null
                    };
                }
            };

            workerAssetUrlRE.lastIndex = 0;
            if (workerAssetUrlRE.test(code)) {
                let toRelativeRuntime = createToImportMetaURLBasedRelativeRuntime(outputOptions.format);

                let match: RegExpExecArray | null;
                s = new MagicString(code);
                workerAssetUrlRE.lastIndex = 0;

                let { fileNameHash } = workerCache;

                while ((match = workerAssetUrlRE.exec(code))) {
                    let [full, hash] = match;
                    let filename = fileNameHash.get(hash)!;
                    let replacement = toOutputFilePath(filename, chunk.fileName, config, toRelativeRuntime);
                    let replacementString =
                        typeof replacement === "string"
                            ? JSON.stringify(encodeURI(replacement)).slice(1, -1)
                            : `"+${replacement.runtime}+"`;
                    s.update(match.index, match.index + full.length, replacementString);
                }
            }
            return result();
        },

        generateBundle(opts) {
            //@ts-ignore
            if (opts.__joker_skip_asset_emit__) {
                return;
            }

            workerCache.assets.forEach((m) => {
                this.emitFile(m);

                workerCache.assets.delete(m.fileName!);
            });
        }
    };
}

async function bundleWorkerEntry(
    config: ResolvedConfig,
    id: string,
    query?: Record<string, string>
): Promise<OutputChunk> {
    let plugins = [await config.build.worker.plugins?.(id)].flat().filter(Boolean);

    if (config.build.minify) {
        plugins.push(terserPlugin(config));
    }
    let bundle = await rollup({
        ...config.build.worker.rollupOptions,
        input: cleanUrl(id),
        plugins,
        onwarn(warning, warn) {
            onRollupWarning(config, warning, warn);
        },
        preserveEntrySignatures: false
    });

    let chunk: OutputChunk;

    try {
        let generateResult = await bundle.generate({
            entryFileNames: path.posix.join(config.build.assetsDir, "[name]-[hash].js"),
            chunkFileNames: path.posix.join(config.build.assetsDir, "[name]-[hash].js"),
            assetFileNames: path.posix.join(config.build.assetsDir, "[name]-[hash].[ext]"),

            ...config.build.rollupOptions.output,
            sourcemap: config.build.sourcemap
        });

        let [outputChunk, ...outputChunks] = generateResult.output;
        chunk = outputChunk;
        outputChunks.forEach((m) => {
            if (m.type === "asset") {
                workerCache.assets.set(m.fileName, m);
            } else if (m.type === "chunk") {
                workerCache.assets.set(m.fileName, {
                    fileName: m.fileName,
                    source: m.code,
                    type: "asset"
                });
            }
        });
    } finally {
        await bundle.close();
    }

    return emitSourcemapForWorkerEntry(config, query, chunk);
}

let workerCache = {
    assets: new Map<string, EmittedAsset>(),
    bundle: new Map<string, string>(),
    fileNameHash: new Map<string, string>()
};

function emitSourcemapForWorkerEntry(
    config: ResolvedConfig,
    query: Record<string, string> | undefined,
    chunk: OutputChunk
): OutputChunk {
    if (chunk.map) {
        if (config.build.sourcemap) {
            let data = chunk.map.toString();
            let mapFileName = chunk.fileName + ".map";

            workerCache.assets.set(mapFileName, {
                fileName: mapFileName,
                type: "asset",
                source: data
            });

            let sourceMapUrl =
                query?.inline !== undefined ? mapFileName : path.relative(config.build.assetsDir, mapFileName);

            chunk.code += `//# sourceMappingURL=${sourceMapUrl}`;
        }
    }
    return chunk;
}

export async function workerFileToUrl(config: ResolvedConfig, id: string): Promise<string> {
    let fileName = workerCache.bundle.get(id);
    if (!fileName) {
        let outputChunk = await bundleWorkerEntry(config, id);
        fileName = outputChunk.fileName;
        workerCache.assets.set(fileName, {
            fileName,
            type: "asset",
            source: outputChunk.code
        });

        workerCache.bundle.set(id, fileName);
    }
    return encodeWorkerAssetFileName(fileName);
}

function encodeWorkerAssetFileName(fileName: string): string {
    let { fileNameHash } = workerCache;
    let hash = getHash(fileName);
    if (!fileNameHash.get(hash)) {
        fileNameHash.set(hash, fileName);
    }
    return `__JOKER_WORKER_ASSET__${hash}__`;
}
