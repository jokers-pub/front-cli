import { cleanUrl, isDataUrl, isExternalUrl } from "@joker.front/shared";
import { ExportSpecifier, ImportSpecifier, init, parse as parseImports } from "es-module-lexer";
import MagicString from "magic-string";
import path from "node:path";
import { CLIENT_DIR, CLIENT_ENTRY, CLIENT_PLUBLIC_PATH, FS_PREFIX, getClinetImport, ResolvedConfig } from "../config";
import { logger } from "../logger";
import { Plugin } from "../plugin";
import { Server } from "../server";
import { acceptedHMRDeps, acceptedHMRExports, normalizeHMRUrl, hmrPruned } from "../server/hmr";
import { parse as parseJS } from "acorn";
import type { Node } from "estree";
import { makeLegalIdentifier } from "@rollup/pluginutils";

import {
    addUrlQuery,
    addUrlTimerQuery,
    DEP_VERSION_RE,
    fsPathFromUrl,
    generateCodeFrame,
    getFileExtRegex,
    getPublicFilePath,
    isCssRequest,
    isJSRequest,
    NODE_MODULES_RE,
    normalizePath,
    prettifyUrl,
    stripBomTag,
    transformStableResult,
    isDirectCssRequest,
    unwarpId,
    warpId,
    stripBase
} from "../utils";

import { throwOutdatedRequest } from "./resolveDep";
import fs from "node:fs";
import { RollupPluginContext } from "../server/pluginContainer";
import { browserExternalId } from "./resolve";
const LOGTAG = "plugin/importAnalysis";

export function notNeedImportAnalysis(id: string): boolean {
    return /\.(map|json)($|\?)/.test(id) || isDirectCssRequest(id);
}

export function importAnalysisPlugin(config: ResolvedConfig): Plugin {
    let server: Server;
    let clientEntryFile = normalizePath(CLIENT_ENTRY);

    return {
        name: "joker:import-analysis",

        configureServer(_server) {
            server = _server;
        },

        buildEnd() {
            server = undefined as any;
        },

        async transform(source, importer) {
            let root = normalizePath(config.root);
            let importLogUrl = prettifyUrl(importer, root);
            if (importer === clientEntryFile || notNeedImportAnalysis(importer)) {
                logger.debug(LOGTAG, `No references outside import/export points, skipping:${importLogUrl}`);
                return;
            }

            await init;

            let imports!: readonly ImportSpecifier[];
            let exports!: readonly ExportSpecifier[];

            source = stripBomTag(source);

            try {
                [imports, exports] = parseImports(source);
            } catch (e: any) {
                logger.error(
                    LOGTAG,
                    `${importLogUrl}: Failed to parse imports/exports in the code. A corresponding parsing plugin might be missing.`,
                    e
                );
                this.error(`Failed to parse imports/exports in the code`, e.idx);
            }

            let importerModule = server.moduleMap.getModuleById(importer);

            //如果不存在module && 是已解析的缓存
            if (!importerModule && config.depHandler.isResolvedDepFile(importer)) {
                //重置resolved索引，用于下次重置版本v=?
                config.depHandler.server?.pluginContainer.resolveIdCache.clear();
                //已解析的缓存可能在新的项目中被移除
                throwOutdatedRequest(importer);
            }

            //该判断条件只做容错，按流程该插件是在最后执行，依赖入口应该已经都被解析
            if (importerModule === undefined) {
                logger.error(LOGTAG, `${importLogUrl}: Mapping data not found in moduleMap`);
                return;
            }

            if (imports.length === 0) {
                importerModule.isSelfAccepting = false;
                logger.debug(LOGTAG, `${importLogUrl} has no imports, skipping`);
                return;
            }

            let normalizeUrl = async (url: string, pos: number): Promise<[string, string]> => {
                url = stripBase(url, config.base);

                let resolved = await this.resolve(url, importer);

                if (!resolved) {
                    return this.error(
                        logger.error(
                            LOGTAG,
                            `Failed to parse import ${url} from ${path.relative(
                                process.cwd(),
                                importer
                            )}. Please verify the file exists.`
                        )
                    );
                }

                let isRelative = url.startsWith(".");
                let isSelfImport = isRelative === false && cleanUrl(url) === cleanUrl(importer);

                if (resolved.id.startsWith(root + "/")) {
                    url = resolved.id.slice(root.length);
                }
                //depCache || 文件存在
                else if (resolved.id.startsWith(config.depHandler.depCache.cacheDirPrefix)) {
                    url = path.posix.join(FS_PREFIX + resolved.id);
                } else if (fs.existsSync(cleanUrl(resolved.id))) {
                    logger.debug(
                        LOGTAG,
                        `The reference ${url} -> ${resolved.id} exceeds the root directory scope. Please adjust it promptly.`
                    );

                    url = path.posix.join(FS_PREFIX + resolved.id);
                } else {
                    url = resolved.id;
                }

                if (isExternalUrl(url)) {
                    return [url, url];
                }

                if (url.startsWith(".") === false && url.startsWith("/") === false) {
                    url = warpId(resolved.id);
                }

                url = markExplicitImportQuery(url);

                //为转换后的url添加丢失的depversion
                if (
                    (isRelative || isSelfImport) &&
                    /[\?&]import=?\b/.test(url) === false &&
                    url.match(DEP_VERSION_RE) === null
                ) {
                    let versionMatch = importer.match(DEP_VERSION_RE);

                    if (versionMatch) {
                        url = addUrlQuery(url, versionMatch[1]);
                    }
                }

                try {
                    let depModule = await server.moduleMap.addEntryModuleUrl(unwarpId(url), notNeedImportAnalysis(url));

                    if (depModule.lastHMRTimer > 0) {
                        url = addUrlTimerQuery(url, depModule.lastHMRTimer);
                    }
                } catch (e: any) {
                    e.pos = pos;
                    throw e;
                }

                url = config.base + url.replace(/^\//, "");

                return [url, resolved.id];
            };

            let hasHMR = false;
            let hasDefine = false;
            let acceptedExports = new Set<string>();
            let needQueryInjectHelper = false;
            let isPartSelfAccepting = false;
            let isSelfAccepting = false;
            let importedUrls = new Set<string>();
            let staticImportedUrls = new Set<{ url: string; id: string }>();
            let s: MagicString | undefined;
            let str = () => s || (s = new MagicString(source));
            let acceptedDeps = new Set<{
                url: string;
                start: number;
                end: number;
            }>();

            for (let index = 0; index < imports.length; index++) {
                let {
                    s: start,
                    e: end,
                    ss: expStart,
                    se: expEnd,
                    d: dynamicIndex,
                    n: specifier,
                    a: assertIndex
                } = imports[index];

                let rawUrl = source.slice(start, end);

                if (rawUrl === "import.meta") {
                    let prop = source.slice(end, end + 4);

                    //用于处理import.meta.hot，处理自定义热更新逻辑
                    if (prop === ".hot") {
                        hasHMR = true;

                        let afterConent = source.substring(end + 4);
                        if (afterConent.startsWith(".accept")) {
                            if (afterConent.startsWith(".acceptExports")) {
                                acceptedHMRExports(source, source.indexOf("(", end + 18) + 1, acceptedExports);

                                isPartSelfAccepting = true;
                            } else if (acceptedHMRDeps(source, source.indexOf("(", end + 11) + 1, acceptedDeps)) {
                                isSelfAccepting = true;
                            }
                        }
                    } else if (prop === ".define") {
                        hasDefine = true;
                    }

                    continue;
                }

                let isDynamicImport = dynamicIndex > -1;

                if (!isDynamicImport && assertIndex > -1) {
                    str().remove(end + 1, expEnd);
                }

                let clientPublicPath = path.posix.join(config.base, CLIENT_PLUBLIC_PATH);

                if (specifier) {
                    if (isExternalUrl(specifier) || isDataUrl(specifier)) {
                        continue;
                    }

                    if (specifier === clientPublicPath) {
                        continue;
                    }

                    //e.g. => /publicDir 非资源非json
                    if (
                        specifier.startsWith("/") &&
                        getFileExtRegex(config.assetsInclude).test(cleanUrl(specifier)) === false &&
                        specifier.endsWith(".json") === false &&
                        getPublicFilePath(config.publicDir, specifier)
                    ) {
                        throw new Error(
                            logger.error(
                                LOGTAG,
                                `${specifier} is not allowed to reference non-resource and non-JSON files (such as JS/CSS) under the publicDir directory.`
                            )
                        );
                    }

                    let [url, resolvedId] = await normalizeUrl(specifier, start);

                    //记录
                    server.moduleMap.safeModulesPath.add(fsPathFromUrl(url));

                    if (url !== specifier) {
                        let rewriteDone = false;

                        if (config.depHandler.isResolvedDepFile(resolvedId)) {
                            let file = cleanUrl(resolvedId);

                            let needsRewrite = await config.depHandler.resolvedDepNeedRewriteImport(file);

                            if (needsRewrite === undefined) {
                                if (file.match(/-[A-Z0-9]{8}\.js/) === null) {
                                    logger.error(LOGTAG, `${url}: The DepInfo of this file is incorrect`);
                                }
                            } else if (needsRewrite) {
                                logger.debug(LOGTAG, `${url} requires conversion of import style`);
                                rewriteNamedImports(str(), imports[index], url, index);
                                rewriteDone = true;
                            }
                        } else if (url.includes(browserExternalId) && source.slice(expStart, start).includes("{")) {
                            rewriteNamedImports(str(), imports[index], url, index);
                            rewriteDone = true;
                        }

                        if (rewriteDone === false) {
                            let rewrittenUrl = JSON.stringify(url);

                            if (isDynamicImport === false) {
                                rewrittenUrl = rewrittenUrl.slice(1, -1);
                            }

                            str().overwrite(start, end, rewrittenUrl, {
                                contentOnly: true
                            });
                        }
                    }

                    let hmrUrl = unwarpId(stripBase(url, config.base));
                    importedUrls.add(hmrUrl);

                    if (isDynamicImport === false) {
                        staticImportedUrls.add({ url: hmrUrl, id: resolvedId });
                    }
                } else if (importer.startsWith(normalizePath(CLIENT_DIR)) === false) {
                    if (NODE_MODULES_RE.test(importer) === false) {
                        let warnMessage = `${importerModule.file} does not support import parsing:\n${generateCodeFrame(
                            source,
                            start
                        )}`;
                        logger.warn(LOGTAG, warnMessage);
                    }

                    let url = rawUrl.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, "").trim();

                    if (/^('.*'|".*"|`.*`)$/.test(url) === false || isExplicitImportRequired(url.slice(1, -1))) {
                        needQueryInjectHelper = true;
                        str().overwrite(start, end, `__joker__injectQuery(${url},'import')`, {
                            contentOnly: true
                        });
                    }
                }
            }
            if (hasDefine) {
                let define = `import.meta.define = ${JSON.stringify(config.define)};`;

                str().prepend(define);
            }

            if (hasHMR) {
                str().prepend(
                    `import { JokerHotContext as __joker__HotContext } from "${getClinetImport(config)}";` +
                        `import.meta.hot = new __joker__HotContext(${JSON.stringify(
                            normalizeHMRUrl(importerModule.url)
                        )});`
                );
            }

            if (needQueryInjectHelper) {
                str().append(`import { injectQuery as __joker__injectQuery } from "${getClinetImport(config)}";`);
            }

            let normalizedAcceptedUrls = new Set<string>();

            for (let item of acceptedDeps) {
                let absoluteUrl = path.posix.resolve(
                    path.posix.dirname(importerModule.url),
                    markExplicitImportQuery(item.url)
                );
                let resolvedUrl = await (await server.moduleMap.resolveUrl(absoluteUrl)).url;

                normalizedAcceptedUrls.add(resolvedUrl);

                str().overwrite(item.start, item.end, JSON.stringify(resolvedUrl), { contentOnly: true });
            }

            if (isCssRequest(importer) === false) {
                //动态添加的import
                let pluginImports = (this as unknown as RollupPluginContext)._addedImports;

                if (pluginImports) {
                    (await Promise.all(Array.from(pluginImports).map((id) => normalizeUrl(id, 0)))).forEach(([url]) =>
                        importedUrls.add(url)
                    );
                }

                //伪自接受
                if (
                    isSelfAccepting === false &&
                    isPartSelfAccepting &&
                    acceptedExports.size >= exports.length &&
                    exports.every((m) => acceptedExports.has(m.n))
                ) {
                    isSelfAccepting = true;
                }

                let noLongerImported = await server.moduleMap.updateModuleInfo(
                    importerModule,
                    importedUrls,
                    normalizedAcceptedUrls,
                    isPartSelfAccepting ? acceptedExports : null,
                    isSelfAccepting
                );

                //具有HMR && 有不再使用的import更新
                if (hasHMR && noLongerImported) {
                    hmrPruned(noLongerImported, server);
                }

                logger.debug(LOGTAG, `Rewrote ${importedUrls.size} imports from ${importLogUrl}`);
            }

            if (s) {
                return transformStableResult(s, importer, config);
            } else {
                return source;
            }
        }
    };
}

export function isExplicitImportRequired(url: string): boolean {
    return isJSRequest(cleanUrl(url)) === false && isCssRequest(url) === false;
}

export function rewriteNamedImports(
    str: MagicString,
    importSpecifier: ImportSpecifier,
    rewrittenUrl: string,
    importIndex: number
): void {
    let source = str.original;

    let { s: start, e: end, ss: expStart, se: expEnd, d: dynamicIndex } = importSpecifier;

    if (dynamicIndex > -1) {
        str.overwrite(
            expStart,
            expEnd,
            `import('${rewrittenUrl}').then(m=>m.default && m.default.__esModule ? m.default : ({ ...m.default, default: m.default }))`,
            { contentOnly: true }
        );
    } else {
        let exp = source.slice(expStart, expEnd);
        let rawUrl = source.slice(start, end);
        let rewritten = transformCjsImport(exp, rewrittenUrl, rawUrl, importIndex);

        if (rewritten) {
            str.overwrite(expStart, expEnd, rewritten, {
                contentOnly: true
            });
        } else {
            str.overwrite(start, end, rewrittenUrl, { contentOnly: true });
        }
    }
}

export function transformCjsImport(
    importExp: string,
    url: string,
    rawUrl: string,
    importIndex: number
): string | undefined {
    let node = (
        parseJS(importExp, {
            ecmaVersion: "latest",
            sourceType: "module"
        }) as any
    ).body[0] as Node;

    if (node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration") {
        if (node.specifiers.length === 0) {
            return `import ${JSON.stringify(url)}`;
        }

        let importNames: { importedName: string; localName: string }[] = [];
        let exportNames: string[] = [];
        let defaultExports: string = "";

        for (let spec of node.specifiers) {
            if (spec.type === "ImportSpecifier" && spec.imported.type === "Identifier") {
                importNames.push({
                    importedName: spec.imported.name,
                    localName: spec.local.name
                });
            } else if (spec.type === "ImportDefaultSpecifier") {
                importNames.push({
                    importedName: "default",
                    localName: spec.local.name
                });
            } else if (spec.type === "ImportNamespaceSpecifier") {
                importNames.push({
                    importedName: "*",
                    localName: spec.local.name
                });
            } else if (spec.type === "ExportSpecifier" && spec.exported.type === "Identifier") {
                if (spec.exported.name === "default") {
                    defaultExports = makeLegalIdentifier(`__joker__cjsExportDefault_${importIndex}`);
                    importNames.push({
                        importedName: spec.local.name,
                        localName: defaultExports
                    });
                } else {
                    let localName = makeLegalIdentifier(`__joker__cjsExport_${spec.exported.name}`);

                    importNames.push({
                        importedName: spec.local.name,
                        localName
                    });

                    exportNames.push(`${localName} as ${spec.exported.name}`);
                }
            }
        }

        let cjsModuleName = makeLegalIdentifier(`__joker__cjsImport${importIndex}_${rawUrl}`);

        let lines: string[] = [`import ${cjsModuleName} from ${JSON.stringify(url)}`];

        importNames.forEach((m) => {
            if (m.importedName === "*") {
                lines.push(`const ${m.localName} = ${cjsModuleName}`);
            } else if (m.importedName === "default") {
                lines.push(
                    `const ${m.localName} = ${cjsModuleName}.__esModule ? ${cjsModuleName}.default : ${cjsModuleName}`
                );
            } else {
                lines.push(`const ${m.localName} = ${cjsModuleName}["${m.importedName}"]`);
            }
        });

        if (defaultExports) {
            lines.push(`export default ${defaultExports}`);
        }

        if (exportNames.length) {
            lines.push(`export { ${exportNames.join(", ")} }`);
        }

        return lines.join(";");
    }
}

function markExplicitImportQuery(url: string) {
    if (isExplicitImportRequired(url)) {
        return addUrlQuery(url, "import");
    }
    return url;
}
