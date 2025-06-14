import fs from "node:fs";
import path from "node:path";
import { logger } from "../logger";

const LOGTAG = "SourceMap";

export async function injectSourcesContent(
    map: {
        sources: string[];
        sourceRoot?: string;
        sourcesContent?: (string | null)[];
    },
    file: string
) {
    let sourceRoot: string | undefined;

    try {
        sourceRoot = await fs.promises.realpath(path.resolve(path.dirname(file), map.sourceRoot || ""));
    } catch {}

    //丢失数据源的sourcePath集合
    let missingSources: string[] = [];

    map.sourcesContent = await Promise.all(
        map.sources.map((sourcePath) => {
            //地址不为空 && 不是虚拟地址
            if (sourcePath && /^(\0|dep:|browser-external:)/.test(sourcePath) === false) {
                sourcePath = decodeURI(sourcePath);

                if (sourceRoot) {
                    sourcePath = path.resolve(sourceRoot, sourcePath);
                }

                return fs.promises.readFile(sourcePath, "utf-8").catch(() => {
                    missingSources.push(sourcePath);
                    return null;
                });
            }
            return null;
        })
    );

    if (missingSources.length) {
        logger.debug(
            LOGTAG,
            `file:${file}; Missing source files. Missing data sources:\n  ${missingSources.join("\n  ")}`
        );
    }
}
