import { Plugin } from "../plugin";
import { ImportSpecifier, init, parse as parseImports } from "es-module-lexer";
import { ResolvedConfig } from "../config";
import { logger } from "../logger";
import path from "node:path";
import { cleanUrl, isDataUrl, isExternalUrl } from "@joker.front/shared";
import MagicString from "magic-string";
import { rewriteNamedImports } from "./importAnalysis";
import {
    BARE_IMPORT_RE,
    combineSourceMaps,
    generateCodeFrame,
    getSourceMapUrl,
    isCssRequest,
    offsetToPosition,
    stripBase
} from "../utils";
import { OutputChunk, SourceMap } from "rollup";
import { removedPureCssFilesCache } from "./css";

const LOGTAG = "import-analysis-build";
const PRELOAD_METHOD = `__jokerPreload`;
const PRELOAD_MARKER = `__JOKER_PRELOAD_MARKER__`;
const PRELOAD_MARKER_WITH_QUOTE_RE = new RegExp(`['"]${PRELOAD_MARKER}['"]`, "g");
const IS_ESMODE_MARKER = `__JOKER_IS_ESMODE_MARKER__`;
const MAP_DEPS_FUNC = `__JOKER__MAP_DEPS__`;

const PRELOAD_HELPER_ID = `\0joker/preload-helper.js`;

export function importAnalysisBuildPlugin(config: ResolvedConfig): Plugin {
    let isRelativeBase = config.base === "./" || config.base === "";

    let insertPreload = !config.build.lib;

    let assetsURL = isRelativeBase
        ? `function(dep,importUrl){return new URL(dep,importerUrl).href;}`
        : `function(dep){return ${JSON.stringify(config.base)}+dep;}`;

    return {
        name: "joker:import-analysis-build",

        resolveId(id) {
            if (id === PRELOAD_HELPER_ID) {
                return id;
            }
        },

        load(id) {
            if (id === PRELOAD_HELPER_ID) {
                //主要提供动态加载切割文件时，带来的其他引用资源，需要前置引入
                //例如：script中import css，需要加载模块前加载
                return [
                    `let assetsURL = ${assetsURL};`,
                    `let seen ={};`,
                    `export let ${PRELOAD_METHOD} = ${preload.toString()}`
                ].join("");
            }
        },

        async transform(source, importer) {
            if (importer.includes("node_modules") && /import\s*\(/.test(source) === false) return;

            await init;

            let imports: readonly ImportSpecifier[] = [];

            try {
                imports = parseImports(source)[0];
            } catch (e: any) {
                this.error(e, e.idx);
            }

            if (imports.length === 0) return;

            let normalizeUrl = async (url: string, pos: number): Promise<[string, string]> => {
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

                if (resolved.id.startsWith(config.root + "/")) {
                    url = resolved.id.slice(config.root.length);
                } else {
                    url = resolved.id;
                }

                if (isExternalUrl(url)) {
                    return [url, url];
                }

                return [url, resolved.id];
            };

            let needPreloadHelper = false;

            let s: MagicString | undefined;
            let str = () => s || (s = new MagicString(source));

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

                let isDynamicImport = dynamicIndex > -1;

                if (isDynamicImport === false && assertIndex > -1) {
                    str().remove(end + 1, expEnd);
                }

                if (isDynamicImport && insertPreload) {
                    needPreloadHelper = true;

                    str().prependLeft(expStart, `${PRELOAD_METHOD}(()=> `);
                    str().appendRight(
                        expEnd,
                        `,${IS_ESMODE_MARKER}?"${PRELOAD_MARKER}":void 0${isRelativeBase ? `,import.meta.url` : ""})`
                    );
                }

                if (specifier) {
                    if (isExternalUrl(specifier) || isDataUrl(specifier)) {
                        continue;
                    }

                    let [url, resolvedId] = await normalizeUrl(specifier, start);

                    if (url !== specifier) {
                        if (
                            config.depHandler.isResolvedDepFile(resolvedId) &&
                            !resolvedId.match(/\/chunk-[A-Z0-9]{8}\.js/)
                        ) {
                            let file = cleanUrl(resolvedId);

                            let needsRewrite = await config.depHandler.resolvedDepNeedRewriteImport(file);
                            let rewriteDone = false;

                            if (needsRewrite === undefined) {
                                if (file.match(/-[A-Z0-9]{8}\.js/) === null) {
                                    logger.error(LOGTAG, `${url}: Incorrect DepInfo for this file`);
                                }
                            } else if (needsRewrite) {
                                logger.debug(LOGTAG, `${url} needs to convert the import method`);
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
                    }
                }

                if (
                    specifier &&
                    isCssRequest(specifier) &&
                    (source.slice(expStart, start).includes("from") || isDynamicImport) &&
                    !specifier.match(/\?used(&|$)/) &&
                    !(BARE_IMPORT_RE.test(specifier) && !specifier.includes("/"))
                ) {
                    let url = specifier.replace(/\?|$/, (m) => `?used${m ? "&" : ""}`);
                    str().overwrite(start, end, isDynamicImport ? `'${url}'` : url, { contentOnly: true });
                }
            }

            if (
                needPreloadHelper &&
                insertPreload &&
                //避免重复写入
                !source.includes(`const ${PRELOAD_METHOD} =`)
            ) {
                str().prepend(`import { ${PRELOAD_METHOD} } from "${PRELOAD_HELPER_ID}";`);
            }

            if (s) {
                return {
                    code: s.toString(),
                    map: config.build.sourcemap ? s.generateMap({ hires: true }) : null
                };
            }
        },

        renderChunk(code, _, { format }) {
            if (code.indexOf(IS_ESMODE_MARKER) > -1) {
                let re = new RegExp(IS_ESMODE_MARKER, "g");
                let isEsMode = String(format === "es");

                if (config.build.sourcemap) {
                    let s = new MagicString(code);
                    let match;

                    while ((match = re.exec(code))) {
                        s.update(match.index, match.index + IS_ESMODE_MARKER.length, isEsMode);
                    }

                    return {
                        code: s.toString(),
                        map: s.generateMap({ hires: true })
                    };
                } else {
                    return code.replace(re, isEsMode);
                }
            }
            return null;
        },

        generateBundle({ format }, bundle) {
            if (format !== "es") return;

            for (let file in bundle) {
                let chunk = bundle[file];

                if (chunk.type === "chunk" && chunk.code.indexOf(PRELOAD_MARKER) > -1) {
                    let code = chunk.code;
                    let imports!: ImportSpecifier[];

                    try {
                        imports = parseImports(code)[0].filter((m) => m.d > -1);
                    } catch (e: any) {
                        let loc = offsetToPosition(code, e.idx);
                        this.error({
                            name: e.name,
                            message: e.message,
                            stack: e.stack,
                            cause: e.cause,
                            pos: e.idx,
                            loc: { ...loc, file: chunk.fileName },
                            frame: generateCodeFrame(code, loc)
                        });
                    }

                    let s = new MagicString(code);
                    let rewwriteMarkerStartPos = new Set();

                    let fileDeps: FileDep[] = [];

                    function addFileDep(url: string, runtime: boolean = false) {
                        let index = fileDeps.findIndex((n) => n.url === url);

                        if (index > -1) {
                            return index;
                        } else {
                            return fileDeps.push({ url, runtime }) - 1;
                        }
                    }

                    if (imports.length) {
                        for (let index = 0; index < imports.length; index++) {
                            let { n: name, s: start, e: end, ss: expStart, se: expEnd } = imports[index];

                            let url = name;

                            if (!url) {
                                let rawUrl = code.slice(start, end);

                                //去除双引号
                                if (rawUrl[0] === '"' && rawUrl[rawUrl.length - 1] === `"`) {
                                    url = rawUrl.slice(1, -1);
                                }
                            }

                            let deps: Set<string> = new Set();
                            let hasRemovedPureCssChunk = false;
                            let normalizedFile: string | undefined = undefined;

                            if (url) {
                                normalizedFile = path.posix.join(path.posix.dirname(chunk.fileName), url);

                                let ownerFilename = chunk.fileName;
                                let analyzed: Set<string> = new Set();

                                let addDeps = (fileanme: string) => {
                                    if (fileanme === ownerFilename) return;
                                    if (analyzed.has(fileanme)) return;

                                    analyzed.add(fileanme);
                                    let chunk = bundle[fileanme] as OutputChunk | undefined;
                                    if (chunk) {
                                        deps.add(chunk.fileName);
                                        chunk.imports.forEach(addDeps);

                                        //追加css module
                                        chunk.jokerMetadata.importedCss.forEach((n) => deps.add(n));
                                    } else {
                                        let removeChunk = removedPureCssFilesCache.get(config)?.get(fileanme);
                                        if (removeChunk) {
                                            if (removeChunk.jokerMetadata.importedCss.size) {
                                                removeChunk.jokerMetadata.importedCss.forEach((n) => deps.add(n));
                                                hasRemovedPureCssChunk = true;
                                            }

                                            s.update(expStart, expEnd, "Promise.resolve({});");
                                        }
                                    }
                                };

                                addDeps(normalizedFile);
                            }

                            let markerStartPos = indexOfMathInSlice(code, PRELOAD_MARKER_WITH_QUOTE_RE, end);

                            //如果不存在 && 只有一个import，尝试从头
                            if (markerStartPos === -1 && imports.length === 1) {
                                markerStartPos = indexOfMathInSlice(code, PRELOAD_MARKER_WITH_QUOTE_RE);
                            }

                            if (markerStartPos > 0) {
                                let depsArray =
                                    deps.size > 1 || (hasRemovedPureCssChunk && deps.size > 0) ? [...deps] : [];

                                let renderedDeps = depsArray.map((m) =>
                                    isRelativeBase ? addFileDep(toRelativePath(m, file)) : addFileDep(m)
                                );

                                s.update(
                                    markerStartPos,
                                    markerStartPos + PRELOAD_MARKER.length + 2,
                                    `${MAP_DEPS_FUNC}([${renderedDeps.join(",")}])`
                                );

                                rewwriteMarkerStartPos.add(markerStartPos);
                            }
                        }
                    }

                    let fileDepsCode = `[${fileDeps
                        .map((m) => (m.runtime ? m.url : JSON.stringify(m.url)))
                        .join(",")}]`;

                    s.append(
                        `function ${MAP_DEPS_FUNC}(indexes){ if(!${MAP_DEPS_FUNC}.__fileDeps){ ${MAP_DEPS_FUNC}.__fileDeps= ${fileDepsCode}; } return indexes.map(m=>${MAP_DEPS_FUNC}.__fileDeps[m]); }`
                    );

                    let markerStartPos = indexOfMathInSlice(code, PRELOAD_MARKER_WITH_QUOTE_RE);

                    while (markerStartPos >= 0) {
                        //clear
                        if (!rewwriteMarkerStartPos.has(markerStartPos)) {
                            s.update(markerStartPos, markerStartPos + PRELOAD_MARKER.length + 2, "void 0");
                        }

                        //next
                        markerStartPos = indexOfMathInSlice(
                            code,
                            PRELOAD_MARKER_WITH_QUOTE_RE,
                            markerStartPos + PRELOAD_MARKER.length + 2
                        );
                    }

                    //update
                    if (s.hasChanged()) {
                        chunk.code = s.toString();

                        //update sourcemap
                        if (config.build.sourcemap && chunk.map) {
                            let nextMap = s.generateMap({
                                source: chunk.fileName,
                                hires: true
                            });

                            //@ts-ignore
                            let map = combineSourceMaps(chunk.fileName, [nextMap, chunk.map]) as SourceMap;
                            map.toUrl = () => getSourceMapUrl(map);
                            chunk.map = map;

                            if (config.build.sourcemap) {
                                let mapAsset = bundle[chunk.fileName + ".map"];

                                //rewrite
                                if (mapAsset && mapAsset.type === "asset") {
                                    mapAsset.source = map.toString();
                                }
                            }
                        }
                    }
                }
            }
        }
    };
}

type FileDep = {
    url: string;
    runtime: boolean;
};

function indexOfMathInSlice(str: string, reg: RegExp, pos: number = 0) {
    reg.lastIndex = pos;

    return reg.exec(str)?.index ?? -1;
}

function toRelativePath(filename: string, importer: string) {
    let relPath = path.posix.relative(path.posix.dirname(importer), filename);

    return relPath[0] === "." ? relPath : `./${relPath}`;
}

async function preload(baseModule: () => Promise<any>, deps?: string[], importUrl?: string) {
    let promise: Promise<any> = Promise.resolve();

    //@ts-ignore 在renderChunk时被重写
    if (__JOKER_IS_ESMODE_MARKER__ && deps?.length) {
        let links = document.getElementsByTagName("link");

        let scriptRel = function () {
            let relList = typeof document !== "undefined" && document.createElement("link").relList;
            return relList && relList.supports && relList.supports("modulepreload") ? "modulepreload" : "preload";
        };

        promise = Promise.all(
            deps.map((dep) => {
                //@ts-ignore
                dep = assetsURL(dep, importUrl);
                //@ts-ignore
                if (dep in seen) return;
                //@ts-ignore
                seen[dep] = true;
                let isCss = dep.endsWith(".css");
                let cssSelector = isCss ? '[rel="stylesheet"]' : "";

                //如果携带stylesheet 则不处理
                if (importUrl) {
                    for (let i = links.length - 1; i >= 0; i--) {
                        let link = links[i];

                        if (link.href === dep && (!isCss || link.rel === "stylesheet")) {
                            return;
                        }
                    }
                } else if (document.querySelector(`link[href="${dep}"]${cssSelector}`)) {
                    return;
                }

                let link = document.createElement("link");

                link.rel = isCss ? "stylesheet" : scriptRel();
                if (isCss === false) {
                    link.as = "script";
                    link.crossOrigin = "";
                }

                link.href = dep;
                document.head.appendChild(link);

                if (isCss) {
                    return new Promise((resolve, reject) => {
                        link.addEventListener("load", resolve);
                        link.addEventListener("error", () => {
                            reject(new Error(`Failed to load CSS: ${dep}`));
                        });
                    });
                }
            })
        );
    }

    try {
        await promise;
        return await baseModule();
    } catch (err) {
        let e = new Event("joker:preloadError", { cancelable: true });

        //@ts-ignore
        e.payload = err;

        window.dispatchEvent(e);
        if (!e.defaultPrevented) {
            throw err;
        }
    }
}
