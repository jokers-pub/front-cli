import { DepHandler } from ".";
import { ESBUILD_MODULES_TARGET, getConfigHash, ResolvedConfig } from "../config";
import fs from "node:fs";
import {
    emptyDir,
    flattenId,
    getHash,
    JS_EXTENSION_RE,
    JS_MAP_EXTENSION_RE,
    normalizePath,
    removeDir,
    renameDir,
    writeFile
} from "../utils";
import path from "node:path";
import { logger } from "../logger";
import { esbuildCjsExternalPlugin, esbuildDepPlugin } from "./esbuildPlugin";
import { init as esModuleLexerInit, parse } from "es-module-lexer";
import { performance } from "node:perf_hooks";
import { build } from "esbuild";
import { DepInfo, DepMetadata, ExportDatas } from "./metadata";
import { cleanUrl } from "@joker.front/shared";

const LOGTAG = "DEP解析";

export async function runResolvedDeps(
    depHandler: DepHandler,
    deps: Record<string, DepInfo>
): Promise<ResolveDepMetadataResult> {
    let isBuild = depHandler.config.command === "build";

    //以此config作为当前构建/转换凭证
    let config: ResolvedConfig = {
        ...depHandler.config,
        command: "build"
    };

    let depCacheDir = depHandler.depCache.cacheDir;
    let processingCacheDir = depCacheDir + "_cache";

    if (fs.existsSync(processingCacheDir)) {
        emptyDir(processingCacheDir);
    } else {
        fs.mkdirSync(processingCacheDir, { recursive: true });
    }

    //写入一个package.json，并标明type，为后面esbuild做准备
    writeFile(path.resolve(processingCacheDir, "package.json"), JSON.stringify({ type: "module" }));

    let metadata = new DepMetadata(depHandler.configHash, deps);

    let result: ResolveDepMetadataResult = {
        metadata,
        async commit() {
            //交替文件夹，转正缓存文件夹
            await removeDir(depCacheDir);
            await renameDir(processingCacheDir, depCacheDir);
        },
        cancel() {
            fs.rmSync(processingCacheDir, { recursive: true, force: true });
        }
    };

    //无引用直接返回即可
    if (Object.keys(deps).length === 0) {
        return result;
    }

    await resolveDep(depHandler, isBuild, config, processingCacheDir, metadata, deps);

    return result;
}

/**
 * 创建一个临时缓存目录，并将esbuild转后的文件放入其内
 * 然后保存cache文件
 * @param depHandler
 * @param isBuild
 * @param config
 * @param processingCacheDir
 * @param metadata
 * @param deps
 */
async function resolveDep(
    depHandler: DepHandler,
    isBuild: boolean,
    config: ResolvedConfig,
    processingCacheDir: string,
    metadata: DepMetadata,
    deps: Record<string, DepInfo>
) {
    let flatIdDeps: Record<string, string> = {};
    let idToExports: Record<string, ExportDatas> = {};
    let flatIdToExports: Record<string, ExportDatas> = {};

    for (let id in deps) {
        let src = deps[id].src!;

        let exportsData = await (deps[id].exportDatas ?? getExportDatas(src));

        let flatId = flattenId(id);

        flatIdDeps[flatId] = src;
        idToExports[id] = exportsData;
        flatIdToExports[flatId] = exportsData;
    }

    let external = [];

    //构建时，考虑roolup配置的external外部引用
    if (isBuild) {
        let rollupOptionsExternal = config.build.rollupOptions?.external;

        if (rollupOptionsExternal) {
            if (typeof rollupOptionsExternal === "string") {
                rollupOptionsExternal = [rollupOptionsExternal];
            }

            if (
                Array.isArray(rollupOptionsExternal) === false ||
                (<any[]>rollupOptionsExternal).some((ext) => typeof ext !== "string")
            ) {
                throw new Error(
                    logger.error(
                        LOGTAG,
                        "Invalid 'external' configuration detected during build. Please check your build configuration."
                    )
                );
            }

            external.push(...(rollupOptionsExternal as string[]));
        }
    }

    let plugins = [];
    if (external.length) {
        plugins.push(esbuildCjsExternalPlugin(external));
    }

    plugins.push(esbuildDepPlugin(flatIdDeps, flatIdToExports, external, config));

    let start = performance.now();

    let result = await build({
        absWorkingDir: process.cwd(),
        entryPoints: Object.keys(flatIdDeps),
        bundle: true,
        platform: "browser",
        define: {
            "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV || config.mode)
        },
        format: "esm",
        target: ESBUILD_MODULES_TARGET,
        external,
        logLevel: "error",
        splitting: true,
        sourcemap: true,
        outdir: processingCacheDir,
        ignoreAnnotations: !isBuild,
        metafile: true,
        plugins,
        supported: {
            "dynamic-import": true,
            "import-meta": true
        }
    });

    let meta = result.metafile;

    let processingCacheDirOutPath = path.relative(process.cwd(), processingCacheDir);

    //将已解析的dep添加到metaData.resolved中
    for (let id in deps) {
        let output =
            meta.outputs[
                normalizePath(path.relative(process.cwd(), path.join(processingCacheDir, flattenId(id) + ".js")))
            ];
        let dep = deps[id];

        metadata.resolved[dep.id] = {
            ...dep,
            fileHash: getHash(metadata.hash + dep.file + JSON.stringify(output.imports)),
            browserHash: metadata.browserHash,
            needRewriteImport: getDepRewriteImport(idToExports[id], output)
        };
    }

    for (let src in meta.outputs) {
        //排除.js.map文件
        if (!src.match(JS_MAP_EXTENSION_RE)) {
            //将相对路径，并剔除.js后缀作为id
            let id = path.relative(processingCacheDirOutPath, src).replace(JS_EXTENSION_RE, "");

            let file = depHandler.getDepPath(id);

            let isExist = false;
            for (let depId in metadata.resolved) {
                if (metadata.resolved[depId].file === file) {
                    isExist = true;
                    break;
                }
            }

            //嵌套依赖项
            if (isExist === false) {
                metadata.chunks[id] = {
                    id,
                    file,
                    needRewriteImport: false,
                    browserHash: metadata.browserHash
                };
            }
        }
    }

    depHandler.depCache.writeCache(metadata, processingCacheDir);

    logger.debug(LOGTAG, `Dependency parsing and caching completed in ${(performance.now() - start).toFixed(2)}ms`);
}

export interface ResolveDepMetadataResult {
    metadata: DepMetadata;

    commit: () => Promise<void>;

    cancel: () => void;
}

/**
 * 获取当前depId 是否需要转换cjs，不考虑冒充esm的dep，将按照错误处理
 * @param exportDatas
 * @param output
 */
export function getDepRewriteImport(exportDatas: ExportDatas, output?: { exports: string[] }): boolean {
    //没有输入、也没有输出，则需要去转换，按export default{} 处理
    if (exportDatas.hasImport === false && exportDatas.exports.length === 0) {
        return true;
    }

    function isSingleDefaultExport(exports: readonly string[]) {
        return exports.length === 1 && exports[0] === "default";
    }

    if (output) {
        //没有输出 ｜｜ 自身标记输出和转换后的输出不一致
        if (
            output.exports.length === 0 ||
            (isSingleDefaultExport(output.exports) && isSingleDefaultExport(exportDatas.exports) === false)
        ) {
            return true;
        }
    }

    return false;
}

export async function getExportDatas(file: string): Promise<ExportDatas> {
    await esModuleLexerInit;

    file = cleanUrl(file);
    let parserResult: ReturnType<typeof parse>;
    let fileContent = fs.readFileSync(file, "utf-8");
    try {
        parserResult = parse(fileContent);
    } catch {
        throw new Error(
            logger.error(LOGTAG, `Failed to parse imports/exports in ${file}. This file type may not be supported.`)
        );
    }

    let [imports, exports, facade] = parserResult;

    return {
        hasImport: imports.length > 0,
        exports: exports.map((m) => m.n),
        facade,
        hasTransferExports: imports.some(({ ss, se }) => {
            return /export\s+\*\s+from/.test(fileContent.slice(ss, se));
        })
    };
}
