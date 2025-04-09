import { cleanUrl } from "@joker.front/shared";
import { FS_PREFIX, ResolvedConfig } from "../config";
import { Plugin } from "../plugin";
import { getFileExtRegex, getHash, getPublicFilePath, isInNodeModules, normalizePath, RAW_RE, URL_RE } from "../utils";
import { promises as fsp } from "node:fs";
import { logger } from "../logger";
import type { OutputOptions, PluginContext } from "rollup";
import * as mrmime from "mrmime";
import path from "node:path";
import { parse as parserUrl } from "node:url";
import MagicString from "magic-string";
import { toOutputFilePath } from "../build";
import { JokerChunkMetadata } from "./metadata";

const LOGTAG = "plugin:asset";

let assetCache: WeakMap<ResolvedConfig, Map<string, string>> = new WeakMap();
let emittedHashSet: WeakMap<ResolvedConfig, Set<string>> = new WeakMap();
export let publicAssetCache: WeakMap<ResolvedConfig, Map<string, string>> = new WeakMap();
let assetHashToFilenameMap: WeakMap<ResolvedConfig, Map<string, string>> = new WeakMap();

export function assetPlugin(config: ResolvedConfig): Plugin {
    publicAssetCache.set(config, new Map());
    assetHashToFilenameMap.set(config, new Map());

    //注册自定义mimeType
    mrmime.mimes["ico"] = "image/x-icon";
    mrmime.mimes["flac"] = "audio/flac";
    mrmime.mimes["aac"] = "audio/aac";
    mrmime.mimes["eot"] = "application/vnd.ms-fontobject";

    return {
        name: "joker:asset",
        buildStart(options) {
            //重置 位置不同
            assetCache.set(config, new Map());
            emittedHashSet.set(config, new Set());
        },
        resolveId(id, importer, options) {
            if (getFileExtRegex(config.assetsInclude).test(cleanUrl(id)) === false) {
                return;
            }

            let publicFile = getPublicFilePath(config.publicDir, id);

            //如果是public公共目录下的文件
            if (publicFile) {
                return id;
            }
        },
        async load(id) {
            //跳过定制约定
            if (id.startsWith("\0")) {
                return;
            }

            //raw检测，需要读取文件
            if (RAW_RE.test(id)) {
                //如果是公共文件，则取公共文件路径，否则返回精简地址
                let file = getPublicFilePath(config.publicDir, id) || cleanUrl(id);
                let fileContent: string = "";

                try {
                    fileContent = await fsp.readFile(file, "utf-8");
                } catch (e) {
                    logger.error(LOGTAG, `raw读取文件流失败：${file}`);
                }
                return `export default ${JSON.stringify(fileContent)}`;
            }

            //不是asset允许类型 && 也不是url标记地址
            if (getFileExtRegex(config.assetsInclude).test(cleanUrl(id)) === false && URL_RE.test(id) === false) {
                return;
            }

            id = id.replace(URL_RE, "$1").replace(/[\?&]$/, "");
            let url = await fileToUrl(id, config, this);

            return `export default ${JSON.stringify(url)}`;
        },
        renderChunk(code, chunk) {
            let match: RegExpExecArray | null;
            let str: MagicString | undefined;

            //处理__JOKER_ASSET协议
            while ((match = ASSET_URL_RE.exec(code))) {
                str ??= new MagicString(code);

                let [full, hash, urlTag = ""] = match;

                let file = getAssetFilename(hash, config) || this.getFileName(hash);

                chunk.jokerMetadata.importedAssets.add(cleanUrl(file));

                let filename = file + urlTag;
                let replacement = toOutputFilePath(filename, chunk.fileName, config, toRelative);

                let replacementStr =
                    typeof replacement === "string"
                        ? //如果返回的地址，则转换引号
                          JSON.stringify(replacement).slice(1, -1)
                        : //否则做语法拼接
                          `"+${replacement.runtime}+"`;

                str.overwrite(match.index, match.index + full.length, replacementStr, {
                    contentOnly: true
                });
            }

            //处理__JOKER_PUBLIC_ASSET协议
            while ((match = PUBLIC_ASSET_URL_RE.exec(code))) {
                str ??= new MagicString(code);

                let [full, hash] = match;

                //一定有值，无需判断，因为设只和配置内部协议是一起执行的
                let publicUrl = publicAssetCache.get(config)!.get(hash)!.slice(1);
                let replacement;
                if (config.build.publicBaseDir) {
                    replacement = normalizePath(config.build.publicBaseDir + "/" + publicUrl);
                } else {
                    replacement = toOutputFilePath(publicUrl, chunk.fileName, config, toRelative);
                }
                let replacementStr =
                    typeof replacement === "string"
                        ? //如果返回的地址，则转换引号
                          JSON.stringify(replacement).substring(1, -1)
                        : //否则做语法拼接
                          `"+${replacement.runtime}+"`;

                str.overwrite(match.index, match.index + full.length, replacementStr, {
                    contentOnly: true
                });
            }

            if (str) {
                return {
                    code: str.toString(),
                    map: config.build.sourcemap ? str.generateMap({ hires: true }) : null
                };
            }

            return null;
        }
    };
}

export async function fileToUrl(id: string, config: ResolvedConfig, ctx: PluginContext): Promise<string> {
    if (config.command === "server") {
        return fileToDevUrl(id, config);
    }

    return await fileToBuildUrl(id, config, ctx);
}

function fileToDevUrl(id: string, config: ResolvedConfig) {
    let result: string;

    if (getPublicFilePath(config.publicDir, id)) {
        result = id;
    } else if (id.startsWith(config.root)) {
        result = `/${path.posix.relative(config.root, id)}`;
    } else {
        result = path.posix.join(FS_PREFIX + id);
    }

    return config.base + result.replace(/^\//, "");
}

async function fileToBuildUrl(
    id: string,
    config: ResolvedConfig,
    ctx: PluginContext,
    skipPublicCheck: boolean = false
) {
    if (skipPublicCheck === false && getPublicFilePath(config.publicDir, id)) {
        return publicFileToBuildUrl(id, config);
    }

    let cache = assetCache.get(config)!;
    let cached = cache.get(id);
    if (cached) {
        return cached;
    }

    let file = cleanUrl(id);
    let fileContent = await fsp.readFile(file);
    let url: string;

    //除svg和html外的资源，按照大小限制，做dataUrl转换
    if (/\.(svg|html)$/.test(file) === false && fileContent.length < config.build.assetsInlineLimit) {
        let mimeType = mrmime.lookup(file) ?? "application/octet-stream";

        url = `data:${mimeType};base64,${fileContent.toString("base64")}`;
    } else {
        let contentHash = getHash(fileContent);
        let { search, hash } = parserUrl(id);

        let urlTag = (search || "") + (hash || "");
        let name = normalizePath(path.relative(config.root, file));
        let fileName = assetFilenamesToFilename(resolveAssetFileNames(config), name, contentHash, fileContent, config);

        let assetHashToFilenameMapCache = assetHashToFilenameMap.get(config)!;
        if (assetHashToFilenameMapCache.has(contentHash) === false) {
            assetHashToFilenameMapCache.set(contentHash, fileName);
        }

        let emittedHashSetCache = emittedHashSet.get(config)!;

        if (emittedHashSetCache.has(contentHash) === false) {
            ctx.emitFile({
                name,
                fileName,
                type: "asset",
                source: new Uint8Array(fileContent),
                originalFileName: name
            });

            emittedHashSetCache.add(contentHash);
        }

        url = `__JOKER_ASSET__${contentHash}__${urlTag ? `$_${urlTag}__` : ""}`;
    }

    cache.set(id, url);

    return url;
}

export function assetFilenamesToFilename(
    assetFileNames: Exclude<OutputOptions["assetFileNames"], undefined>,
    file: string,
    contentHash: string,
    content: string | Buffer,
    config: ResolvedConfig
): string {
    let basename = path.basename(file);

    let extname = path.extname(basename);
    let ext = extname.substring(1);
    let name = "";

    //node_modules 资源 不要做路径处理
    if (isInNodeModules(file) || (config.command === "build" && config.build.lib)) {
        name = basename.slice(0, -extname.length);
    } else {
        name = file.slice(0, -extname.length);
    }
    if (typeof assetFileNames === "function") {
        assetFileNames = assetFileNames({
            name: basename,
            source: typeof content === "string" ? content : new Uint8Array(content),
            type: "asset",
            originalFileName: basename
        });
    }

    if (typeof assetFileNames !== "string") {
        throw new Error(logger.error(LOGTAG, `assetFileNames没有返回string类型的结果`));
    }

    let filename = assetFileNames.replace(/\[\w+\]/g, (placeholder: string): string => {
        switch (placeholder) {
            case "[ext]":
                return ext;
            case "[extname]":
                return extname;
            case "[hash]":
                return contentHash;
            case "[name]":
                return name;
        }

        throw new Error(
            logger.error(LOGTAG, `assFileNames在转换特殊标记时，从${assetFileNames}中发现未识别标记${placeholder}`)
        );
    });

    return filename;
}

export function resolveAssetFileNames(config: ResolvedConfig): Exclude<OutputOptions["assetFileNames"], undefined> {
    let output = config.build.rollupOptions.output;

    let defaultAssetFilenames = path.posix.join(
        config.build.assetsDir,
        config.build.lib ? "[name][extname]" : "[name].[hash][extname]"
    );

    let assetFileNames: Exclude<OutputOptions["assetFileNames"], undefined> =
        (output && Array.isArray(output) === false ? (<OutputOptions>output).assetFileNames : undefined) ??
        defaultAssetFilenames;

    if (output && Array.isArray(output)) {
        assetFileNames = output[0].assetFileNames ?? assetFileNames;
    }

    return assetFileNames;
}

/**
 * 将引用转换为public协议地址
 *
 * 除了转换，还会记录到缓存中，在renderChunk时，区分import引用，并转换文件
 * @param id
 * @param config
 */
export function publicFileToBuildUrl(id: string, config: ResolvedConfig): string {
    let hash = getHash(id, 8);

    let cache = publicAssetCache.get(config)!;
    if (cache.has(hash) === false) {
        cache.set(hash, id);
    }

    return `__JOKER_PUBLIC_ASSET_${hash}__`;
}

export async function urlToBuildUrl(
    url: string,
    importer: string,
    config: ResolvedConfig,
    pluginContext: PluginContext
): Promise<string> {
    if (getPublicFilePath(config.publicDir, url)) {
        return publicFileToBuildUrl(url, config);
    }

    let file = url.startsWith("/") ? path.join(config.root, url) : path.join(path.dirname(importer), url);

    return fileToBuildUrl(file, config, pluginContext, true);
}

export const PUBLIC_ASSET_URL_RE = /__JOKER_PUBLIC_ASSET_([a-z\d]{8})__/g;
export const ASSET_URL_RE = /__JOKER_ASSET__([a-z\d]{8})__(?:\$_(.*?)__)?/g;

export function getAssetFilename(hash: string, config: ResolvedConfig): string | undefined {
    return assetHashToFilenameMap.get(config)!.get(hash);
}

function toRelative(fileName: string, importer: string) {
    return {
        runtime: `new URL(${JSON.stringify(
            path.posix.relative(path.dirname(importer), fileName)
        )},import.meta.url).href`
    };
}

declare module "rollup" {
    export interface RenderedChunk {
        jokerMetadata: JokerChunkMetadata;
    }
}
