import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { ResolvedConfig } from "../config";
import { Plugin } from "../plugin";
import { normalizePath } from "../utils";
import path from "node:path";
import { logger } from "../logger";
import { OutputChunk } from "rollup";

const LOGTAG = "Reports";

export function buildReporterPlugin(config: ResolvedConfig): Plugin {
    let compress = promisify(gzip);
    let chunkLimit = config.build.chunkSizeWarningLimit;
    let transformedCount = 0;
    let chunkCount = 0;

    async function getCompressedSize(code: string | Uint8Array): Promise<string> {
        return ` / gizp: ${
            //@ts-ignore
            ((await compress(typeof code === "string" ? code : Buffer.from(code))).length / 1024).toFixed(2)
        } KiB`;
    }

    function printFileInfo(filePath: string, content: string | Uint8Array, maxLength: number, compressedSize = "") {
        let outDir = normalizePath(path.relative(config.root, path.resolve(config.root, config.build.outDir))) + "/";

        let kibs = content.length / 1024;
        let logType: "warn" | "info" = kibs > chunkLimit ? "warn" : "info";

        logger[logType](LOGTAG, `${outDir}${filePath.padEnd(maxLength + 2)} ${kibs.toFixed(2)} KiB${compressedSize}`);
    }

    return {
        name: "joker:reporter",
        transform(code, id) {
            transformedCount++;
        },
        buildEnd() {
            logger.info(LOGTAG, `A total of ${transformedCount} modules were converted.`);
        },
        renderStart() {
            chunkCount = 0;
        },
        renderChunk() {
            chunkCount++;
        },
        async writeBundle(_, output) {
            let longest = 0;
            let hasLargeChunks = false;
            for (let file in output) {
                let l = output[file].fileName.length;

                if (l > longest) longest = l;
            }

            let deferredLogs: (() => void)[] = [];

            await Promise.all(
                Object.keys(output).map(async (file) => {
                    let item = output[file];

                    if (item.type === "chunk") {
                        let chunk = item as OutputChunk;
                        let log = async () => {
                            printFileInfo(chunk.fileName, chunk.code, longest, await getCompressedSize(chunk.code));
                            if (chunk.map) {
                                printFileInfo(chunk.fileName + ".map", chunk.map.toString(), longest);
                            }
                        };

                        if (chunk.code.length / 1024 > chunkLimit) {
                            deferredLogs.push(log);
                            hasLargeChunks = true;
                        } else {
                            await log();
                        }
                    } else if (item.source) {
                        let isCompressible = /\.(?:html|json|svg|txt|xml|xhtml|css)$/.test(item.fileName);

                        printFileInfo(
                            item.fileName,
                            item.source,
                            longest,
                            isCompressible ? await getCompressedSize(item.source) : undefined
                        );
                    }
                })
            );

            await Promise.all(deferredLogs.map((m) => m()));

            if (config.build.minify && !config.build.lib && hasLargeChunks) {
                logger.warn(
                    LOGTAG,
                    `During the build output process, the output file exceeded the size limit of ${chunkLimit}. Please perform reasonable splitting or customize the size warning threshold via the configuration option config.build.chunkSizeWarningLimit.`
                );
            }
        }
    };
}
