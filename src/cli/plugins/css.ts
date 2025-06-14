import { getClinetImport, ResolvedConfig } from "../config";
import { Plugin } from "../plugin";
import { Server } from "../server";
import type { NormalizedOutputOptions, OutputChunk, RenderedChunk } from "rollup";
import {
    getCodeWithSourcemap,
    getHash,
    getPublicFilePath,
    isCssRequest,
    isDirectCssRequest,
    normalizePath,
    parseRequest,
    SPECIAL_QUERT_RE,
    stripBase
} from "../utils";
import { compileCSS, CssUrlReplacer, CSS_MODULE_RE, finalizeCss, isPrePoscessor, minifyCss } from "../utils/css";
import {
    assetFilenamesToFilename,
    ASSET_URL_RE,
    fileToUrl,
    getAssetFilename,
    publicAssetCache,
    publicFileToBuildUrl,
    PUBLIC_ASSET_URL_RE,
    resolveAssetFileNames
} from "./asset";
import { HTML_PROXY_RESULT, isHtmlProxy } from "./html";
import { ModuleNode } from "../server/moduleMap";
import { injectSourcesContent } from "../server/sourcemap";
import { cleanUrl } from "@joker.front/shared";
import path from "node:path";
import { toOutputFilePath } from "../build";
import MagicString from "magic-string";

const LOGTAG = "CSS插件";

const COMMONJS_PROXY_RE = /\?commonjs-proxy/;

const INLINE_RE = /(\?|&)inline\b/;

export interface CSSOptions {
    /**
     * 预编译样式配置
     */
    preprocessorOptions?: Record<string, any>;

    /**
     * 是否启用SourceMap
     */
    enableSourceMap?: boolean;
}

/**
 * CSS入口文件缓存
 */
export let cssEntryFilesCache: WeakMap<ResolvedConfig, Set<string>> = new WeakMap();

/**
 * 被移除的文件缓存
 */
export let removedPureCssFilesCache: WeakMap<ResolvedConfig, Map<string, RenderedChunk>> = new WeakMap();

let cssModulesCache: WeakMap<ResolvedConfig, Map<string, Record<string, string>>> = new WeakMap();

export function cssPlugin(config: ResolvedConfig): Plugin {
    let server: Server;
    let moduleCache: Map<string, Record<string, string>>;
    let resolveUrl: ReturnType<ResolvedConfig["createResolver"]>;

    return {
        name: "joker:css",

        buildStart() {
            moduleCache = new Map();
            cssModulesCache.set(config, moduleCache);
            removedPureCssFilesCache.set(config, new Map());
            cssEntryFilesCache.set(config, new Set());

            resolveUrl = config.createResolver({
                preferRelative: true,
                tryIndex: false,
                extensions: []
            });
        },

        configureServer(_server) {
            server = _server;
        },

        async transform(code, id) {
            if (isCssRequest(id) === false || COMMONJS_PROXY_RE.test(id) || SPECIAL_QUERT_RE.test(id)) {
                return;
            }

            let urlReplacer: CssUrlReplacer = async (url, importer) => {
                if (getPublicFilePath(config.publicDir, url)) {
                    if (config.command === "build") {
                        return publicFileToBuildUrl(url, config);
                    } else {
                        return config.base + url.slice(1);
                    }
                }

                let resolved = await resolveUrl(url, importer);

                if (resolved) {
                    return fileToUrl(resolved, config, this);
                }
                return url;
            };

            let compileResult = await compileCSS(id, code, config, urlReplacer);

            if (compileResult.modules) {
                moduleCache.set(id, compileResult.modules);
            }

            if (config.command === "server") {
                let thisModule = server.moduleMap.getModuleById(id);

                if (thisModule) {
                    let isSelfAccepting =
                        compileResult.modules === undefined &&
                        INLINE_RE.test(id) === false &&
                        isHtmlProxy(id) === false;
                    if (compileResult.deps) {
                        let depModules = new Set<string | ModuleNode>();

                        for (let file of compileResult.deps) {
                            depModules.add(
                                isCssRequest(file)
                                    ? server.moduleMap.addEntryByFile(file)
                                    : await server.moduleMap.addEntryModuleUrl(
                                          stripBase(await fileToUrl(file, config, this), config.base)
                                      )
                            );
                        }

                        server.moduleMap.updateModuleInfo(thisModule, depModules, new Set(), null, isSelfAccepting);

                        //补充监听，针对公共
                        compileResult.deps.forEach((dep) => {
                            server.addWatchFile(dep);
                        });
                    } else {
                        thisModule.isSelfAccepting = isSelfAccepting;
                    }
                }
            }

            return {
                code: compileResult.code,
                map: compileResult.map
            };
        }
    };
}

export function cssPostPlugin(config: ResolvedConfig): Plugin {
    let styles: Map<string, string> = new Map();

    let hasEmitted = false;
    let pureCssChunks: Set<string>;
    let outputToExtractedCssMap: Map<NormalizedOutputOptions, string>;
    let assetFileNames = [config.build.rollupOptions.output].flat()[0]?.assetFileNames;

    let getCssAssetDirname = (cssAssetName: string) => {
        if (!assetFileNames) {
            return config.build.assetsDir;
        }

        if (typeof assetFileNames === "string") {
            return path.dirname(assetFileNames);
        }

        return path.dirname(
            assetFileNames({
                name: cssAssetName,
                originalFileName: cssAssetName,
                type: "asset",
                source: `/* Internal call for joker, can be ignored */`
            })
        );
    };

    return {
        name: "joker:css-post",

        buildStart() {
            pureCssChunks = new Set();
            outputToExtractedCssMap = new Map();
            hasEmitted = false;
        },

        async transform(code, id) {
            if (isCssRequest(id) === false || COMMONJS_PROXY_RE.test(id) || SPECIAL_QUERT_RE.test(id)) {
                return;
            }

            let inlined = INLINE_RE.test(id);

            //inline && htmlProxy
            if (/(\?|&)inline-css\b/.test(id) && isHtmlProxy(id)) {
                HTML_PROXY_RESULT.set(`${getHash(cleanUrl(id))}_${Number.parseInt(parseRequest(id)!.index)}`, code);

                return `export default '';`;
            }

            //server 下注入sourceMap，并实现Hot热更新
            if (config.command === "server") {
                let getContentWithSourcemap = async (content: string) => {
                    if (config.css.enableSourceMap) {
                        let sourceMap = this.getCombinedSourcemap();

                        await injectSourcesContent(sourceMap, cleanUrl(id));

                        return getCodeWithSourcemap("css", content, sourceMap);
                    }
                    return content;
                };

                if (isDirectCssRequest(id)) {
                    return await getContentWithSourcemap(code);
                }

                if (inlined) {
                    return `export default ${JSON.stringify(code)}`;
                }

                let cssContent = await getContentWithSourcemap(code);

                return [
                    `import {updateStyle as __joker__updateStyle,removeStyle as __joker__removeStyle} from "${getClinetImport(
                        config
                    )}";`,
                    `let __joker__id = ${JSON.stringify(id)};`,
                    `let __joker__css = ${JSON.stringify(cssContent)};`,
                    `__joker__updateStyle(__joker__id,__joker__css);`,
                    `import.meta.hot.accept();\n export default __joker__css;`,
                    `import.meta.hot.prune(()=>__joker__removeStyle(__joker__id));`
                ].join("\n");
            }

            //====== build ========

            if (inlined === false) {
                styles.set(id, code);
            }

            let transformCode: string = "";

            if (inlined) {
                let content = code;
                if (config.build.minify) {
                    content = await minifyCss(content, config);
                }

                transformCode = `export default ${JSON.stringify(content)};`;
            }

            //css module 内容直接清空，在renderChunk时，绑定importCss
            //并在importAnalysisBuild中动态import的分割文件重做资源引入

            return {
                code: transformCode,
                map: { mappings: "" },
                moduleSideEffects: inlined ? false : "no-treeshake"
            };
        },

        async renderChunk(code, chunk, opts) {
            let chunkCss = "";
            let isPureCssChunk = true;

            let ids = Object.keys(chunk.modules);

            for (let id of ids) {
                //配置非纯净CSSID
                if (isCssRequest(id) === false || CSS_MODULE_RE.test(id) || COMMONJS_PROXY_RE.test(id)) {
                    isPureCssChunk = false;
                }

                if (styles.has(id)) {
                    chunkCss += styles.get(id);
                }
            }

            if (chunkCss === "") {
                return null;
            }

            let cssEntryFiles = cssEntryFilesCache.get(config)!;
            let publicAssetUrlMap = publicAssetCache.get(config)!;

            function resolveAssetUrlsInCss(chunkCss: string, cssAssetName: string) {
                let relative = config.base === "./" || config.base === "";

                let cssAssetDirname = config.command === "build" || relative ? getCssAssetDirname(cssAssetName) : "";

                let toRelative = (filename: string, importer: string) => {
                    let relativePath = path.posix.relative(cssAssetDirname, filename);

                    return relativePath.startsWith(".") ? relativePath : "./" + relativePath;
                };

                chunkCss = chunkCss.replace(ASSET_URL_RE, (_, fileHash, postfix = "") => {
                    let filename = getAssetFilename(fileHash, config) + postfix;

                    chunk.jokerMetadata.importedAssets.add(cleanUrl(filename));

                    return toOutputFilePath(filename, cssAssetName, config, toRelative);
                });

                if (config.command === "build") {
                    let relativePathToPublicFromCss = path.posix.relative(cssAssetDirname, "");

                    chunkCss = chunkCss.replace(PUBLIC_ASSET_URL_RE, (_, hash) => {
                        let publicUrl = publicAssetUrlMap.get(hash)?.slice(1) || "";
                        if (config.build.publicBaseDir) {
                            return `${normalizePath(config.build.publicBaseDir + "/" + publicUrl)}`;
                        }
                        return toOutputFilePath(
                            publicUrl,
                            cssAssetDirname,
                            config,
                            () => `${relativePathToPublicFromCss}/${publicUrl}`
                        );
                    });
                }

                return chunkCss;
            }

            if (isPureCssChunk) {
                pureCssChunks.add(chunk.fileName);
            }

            if (opts.format === "es" || opts.format === "cjs") {
                let cssAssetName = chunk.facadeModuleId
                    ? normalizePath(path.relative(config.root, cleanUrl(chunk.facadeModuleId)))
                    : chunk.name;

                let lang = path.extname(cssAssetName).slice(1);
                let cssFileName = path.format({ ...path.parse(cssAssetName), base: undefined, ext: ".css" });

                if (chunk.isEntry && isPureCssChunk) {
                    cssEntryFiles.add(cssAssetName);
                }

                chunkCss = resolveAssetUrlsInCss(chunkCss, cssAssetName);
                chunkCss = await finalizeCss(chunkCss, true, config);

                let fileHandle = this.emitFile({
                    name: isPrePoscessor(lang) ? cssAssetName : cssFileName,
                    fileName: assetFilenamesToFilename(
                        resolveAssetFileNames(config),
                        cssFileName,
                        getHash(chunkCss),
                        chunkCss,
                        config
                    ),
                    type: "asset",
                    source: chunkCss
                });

                chunk.jokerMetadata.importedCss.add(this.getFileName(fileHandle));
            } else {
                chunkCss = await finalizeCss(chunkCss, true, config);

                let injectCode = [
                    `let __joker_style__ = documnet.createElement('style')`,
                    `__joker_style__.innerHTML = ${JSON.stringify(chunkCss)}`,
                    `documnet.head.appendChild(__joker_style__)`
                ].join(";");

                let str = new MagicString(code);
                str.append(injectCode);

                return {
                    code: str.toString(),
                    map: config.build.sourcemap ? str.generateMap({ hires: true }) : undefined
                };
            }

            return null;
        },

        augmentChunkHash(chunk) {
            if (chunk.jokerMetadata.importedCss.size) {
                let result = "";

                for (let id of chunk.jokerMetadata.importedCss) {
                    result += id;
                }
                return result;
            }
        },

        async generateBundle(options, bundle, isWrite) {
            //@ts-ignore
            if (options.__joker_skip_asset_emit__) {
                return;
            }

            if (pureCssChunks.size) {
                let emptyChunkFiles = [...pureCssChunks]
                    .map((file) => path.basename(file))
                    .join("|")
                    .replace(/\./g, "\\.");

                let emptyChunkRE = new RegExp(
                    options.format === "es"
                        ? `\\bimport\\s*["'][^"']*(?:${emptyChunkFiles})["'];\n?`
                        : `\\brequire\\(\\s*["'][^"']*(?:${emptyChunkFiles})["']\\);\n?`,
                    "g"
                );

                for (let file in bundle) {
                    let chunk = bundle[file];

                    if (chunk.type === "chunk") {
                        chunk.imports = chunk.imports.filter((file) => {
                            if (pureCssChunks.has(file)) {
                                let {
                                    jokerMetadata: { importedCss, importedAssets }
                                } = bundle[file] as OutputChunk;

                                importedCss.forEach((f) => {
                                    (chunk as any).jokerMetadata.importedCss.add(f);
                                });

                                importedAssets.forEach((f) => {
                                    (chunk as any).jokerMetadata.importedAssets.add(f);
                                });
                                return false;
                            }
                            return true;
                        });

                        chunk.code = chunk.code.replace(emptyChunkRE, (m) => `/* 空CSS ${``.padEnd(m.length - 10)}*/`);
                    }
                }

                let removedPureCssFiles = removedPureCssFilesCache.get(config);

                pureCssChunks.forEach((filename) => {
                    removedPureCssFiles!.set(filename, bundle[filename] as RenderedChunk);

                    delete bundle[filename];
                });
            }

            let extractedCss = outputToExtractedCssMap.get(options);

            if (extractedCss && hasEmitted === false) {
                hasEmitted = true;

                extractedCss = await finalizeCss(extractedCss, true, config);

                this.emitFile({
                    name: "style.css",
                    type: "asset",
                    source: extractedCss
                });
            }
        }
    };
}
