import { parserSFC, SFCDescriptor } from "@joker.front/sfc";
import { ResolvedConfig } from "../../config";
import { logger } from "../../logger";
import { generateCodeFrame, getHash, normalizePath } from "../../utils";
import path from "node:path";
import fs from "node:fs";

const LOGTAG = "Joker:SFC";

export interface JokerParserResult {
    hash: string;
    descriptor: SFCDescriptor;
}
export const JOKER_PARSER_CACHE: WeakMap<ResolvedConfig, Map<string, JokerParserResult>> = new WeakMap();
export const HOT_JOKER_PARSER_CACHE: WeakMap<ResolvedConfig, Map<string, JokerParserResult>> = new WeakMap();

export function getSFCDescriptor(
    config: ResolvedConfig,
    filename: string,
    createIfNotFound: boolean = true
): JokerParserResult | undefined {
    let cache = JOKER_PARSER_CACHE.get(config)!;

    if (cache.has(filename)) {
        return cache.get(filename);
    }

    if (createIfNotFound) {
        try {
            return parserSFCFile(config, filename, fs.readFileSync(filename, "utf-8"));
        } catch (e: any) {
            throw new Error(logger.error(LOGTAG, `转换${filename}=》SFC失败`, e));
        }
    }
}

export function parserSFCFile(config: ResolvedConfig, filename: string, source: string) {
    let parserResult = parserSFC(source, {
        keepComment: config.command !== "build",
        filename,
        root: config.root,
        enableMap: true,
        onWarn(msg, content) {
            logger.warn(LOGTAG, msg + "\n" + generateCodeFrame(source, content.start, content.end));
        }
    });

    //生成hash，作为id
    let result = {
        hash: getHash(
            normalizePath(path.relative(config.root, filename)) + (config.command === "build" ? source : ""),
            8
        ),
        descriptor: parserResult
    };

    JOKER_PARSER_CACHE.get(config)!.set(filename, result);

    return result;
}

export function getHotSFCDescriptor(config: ResolvedConfig, fileName: string): JokerParserResult | undefined {
    return HOT_JOKER_PARSER_CACHE.get(config)?.get(fileName);
}

export function setHotSFCDescriptor(config: ResolvedConfig, fileName: string, item: JokerParserResult): void {
    HOT_JOKER_PARSER_CACHE.get(config)?.set(fileName, item);
}
