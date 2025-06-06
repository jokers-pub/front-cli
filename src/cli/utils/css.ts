import { ResolveFn } from "../plugins/resolve";
import loadPostcssConfig from "postcss-load-config";
import { logger } from "../logger";
import { ResolvedConfig } from "../config";
import {
    asyncReplace,
    clearCssComments,
    combineSourceMaps,
    CSS_LANG,
    CSS_LANG_RE,
    extractPnpmPackagePath,
    generateCodeFrame,
    getPublicFilePath,
    normalizePath,
    PNPM_RE,
    SHIMS_CSS_LANG_RE,
    transformSrcSetUrl,
    urlToFileURL
} from ".";
import type { ExistingRawSourceMap, PluginHooks, RollupError, SourceMapInput } from "rollup";
import type Sass from "sass";
import type Less from "less";
import * as PostCss from "postcss";
import path from "node:path";
import fs from "node:fs";
import { cleanUrl, getUrlQueryParams, isDataUrl, isExternalUrl } from "@joker.front/shared";
import MagicString from "magic-string";
import type { RawSourceMap } from "@ampproject/remapping";
import postcssImport from "postcss-import";
import postcssModules from "postcss-modules";
import postcssSelectorParser from "postcss-selector-parser";
import glob from "fast-glob";
import { formatMessages, transform } from "esbuild";
import { StringOptions } from "sass";

const LOGTAG = "CSS工具";

export const CSS_MODULE_RE = new RegExp(`\\.module${CSS_LANG}`);

const CSS_URL_RE = /(?<=^|[^\w\-\u0080-\uffff])url\(\s*('[^']+'|"[^"]+"|[^'")]+)\s*\)/;

const CSS_DATA_URI_RE = /(?<=^|[^\w\-\u0080-\uffff])data-uri\(\s*('[^']+'|"[^"]+"|[^'")]+)\s*\)/;

const IMPORT_CSS_RE = /@import ('[^']+\.css'|"[^"]+\.css"|[^'")]+\.css)/;

const CSS_IMAGE_SET_RE = /(?<=image-set\()((?:[\w\-]+\([^\)]*\)|[^)])*)(?=\))/;

export type CssUrlReplacer = (url: string, importer?: string) => string | Promise<string>;

export interface CSSAtImportResolvers {
    css: ResolveFn;
    sass: ResolveFn;
    less: ResolveFn;
}

export async function compileCSS(
    id: string,
    code: string,
    config: ResolvedConfig,
    urlReplacer: CssUrlReplacer
): Promise<{
    code: string;
    map?: SourceMapInput;
    ast?: PostCss.Result;
    modules?: Record<string, string>;
    deps?: Set<string>;
}> {
    let atImportResolvers: CSSAtImportResolvers = createCSSResolvers(config);

    let isModule = CSS_MODULE_RE.test(id);
    let needInlineImport = code.includes("@import");

    let postcssConfig = await resolvePostcssConfig(config);
    let lang = (id.match(CSS_LANG_RE)?.[1] as CSSLang) || (id.match(SHIMS_CSS_LANG_RE)?.[2] as CSSLang);

    if (!lang) {
        logger.error(LOGTAG, `未从${id}中解析出样式语言`);
        return { code: "" };
    }

    let scoped: string = getUrlQueryParams(id).scoped || "";

    let preprocessorMap: ExistingRawSourceMap | undefined;
    let deps: Set<string> = new Set();
    let modules: Record<string, string> | undefined;

    if (isPrePoscessor(lang)) {
        let preProcessor = PREPROCESSORS[lang];

        let opts = config.css.preprocessorOptions?.[lang] || {};
        switch (lang) {
            case "sass":
            case "scss":
                opts = {
                    includePaths: ["node_modules"],
                    ...opts
                };
                break;
            case "less":
                opts = {
                    paths: ["node_modules"],
                    ...opts
                };
                break;
        }

        opts.filename = cleanUrl(id);
        opts.enableSourceMap = config.css.enableSourceMap ?? false;

        let preprocessResult = await preProcessor(code, config.root, opts, atImportResolvers);

        if (preprocessResult.errors.length) {
            throw preprocessResult.errors[0];
        }

        preprocessorMap = combineSourceMapsIfExists(opts, preprocessResult.map, preprocessResult.additionalMap);

        preprocessResult.deps.forEach((dep) => {
            if (normalizePath(dep) !== normalizePath(opts.filename)) {
                deps.add(dep);
            }
        });

        code = preprocessResult.code;
    }

    let postcssOptions = postcssConfig?.options || {};

    let postcssPlugins = [...(postcssConfig?.plugins || [])];

    if (needInlineImport) {
        postcssPlugins.unshift(
            postcssImport({
                async resolve(id, basedir, importOptions) {
                    let publicFile = getPublicFilePath(config.publicDir, id);
                    if (publicFile) {
                        return publicFile;
                    }

                    let resolved = await atImportResolvers.css(id, path.join(basedir, "*"));

                    if (resolved) {
                        return path.resolve(resolved);
                    }

                    if (PNPM_RE.test(basedir)) {
                        //pnpm 依赖查询
                        let realPackagePath = extractPnpmPackagePath(basedir);

                        let resolved = await atImportResolvers.css(id, realPackagePath);

                        if (resolved) {
                            return path.resolve(resolved);
                        }
                    }
                    return id;
                }
            })
        );
    }

    postcssPlugins.push({
        postcssPlugin: "joker:url-rewrite",
        Once(root) {
            let promises: Promise<void>[] = [];
            let hasWarn = false;
            root.walkDecls((declaration) => {
                let importer = declaration.source?.input.file;

                if (!importer && hasWarn === false) {
                    logger.warn(LOGTAG, "postcss插件在执行时，没有传入确定的importer，这将导致不确定的引用关系。");
                    hasWarn = true;
                }

                let isCssUrl = CSS_URL_RE.test(declaration.value);
                let isCssImageSet = CSS_IMAGE_SET_RE.test(declaration.value);

                if (isCssUrl || isCssImageSet) {
                    let replacerForDeclaration = (rawUrl: string) => {
                        return urlReplacer(rawUrl, importer);
                    };

                    let rewriteToUse = isCssImageSet ? rewriteCssImageSet : rewriteCssUrls;

                    promises.push(
                        rewriteToUse(declaration.value, replacerForDeclaration).then((url) => {
                            declaration.value = url;
                        })
                    );
                }
            });

            if (promises.length) {
                return Promise.all(promises) as any;
            }
        }
    });

    if (scoped) {
        postcssPlugins.push(getPostCssScopedPlugin(scoped));
    }
    if (isModule) {
        postcssPlugins.unshift(
            postcssModules({
                getJSON(_, json) {
                    modules = json;
                },
                async resolve(file) {
                    for (let key of Object.keys(atImportResolvers)) {
                        let resolved = await atImportResolvers[key as keyof CSSAtImportResolvers](id);

                        if (resolved) {
                            return path.resolve(resolved);
                        }
                    }
                    return file;
                }
            })
        );
    }

    let postcssResult = await (await import("postcss")).default(postcssPlugins).process(code, {
        ...postcssOptions,
        to: id,
        from: id,
        ...(config.css.enableSourceMap
            ? {
                  map: {
                      inline: false,
                      annotation: false,
                      sourcesContent: true
                  }
              }
            : {})
    });

    for (let message of postcssResult.messages) {
        if (message.type === "dependency") {
            deps.add(normalizePath(message.file));
        } else if (message.type === "dir-dependency") {
            let { dir, glob: globPattern = "**" } = message;

            let pattern = glob.escapePath(normalizePath(path.resolve(path.dirname(id), dir))) + "/" + globPattern;

            let files = glob.sync(pattern, {
                ignore: ["**/node_modules/**"]
            });

            files.forEach((f) => {
                deps.add(f);
            });
        } else if (message.type === "warning") {
            logger.warn(
                LOGTAG,
                message.text +
                    "\n" +
                    generateCodeFrame(code, {
                        line: message.line,
                        column: message.column
                    })
            );
        }
    }

    if (!config.css.enableSourceMap) {
        return {
            ast: postcssResult,
            code: postcssResult.css,
            map: { mappings: "" },
            modules,
            deps
        };
    }

    let rawPostcssMap = postcssResult.map.toJSON();

    let postcssMap = await formatPostcssSourceMap(rawPostcssMap as any, cleanUrl(id));

    return {
        ast: postcssResult,
        code: postcssResult.css,
        map: combineSourceMapsIfExists(cleanUrl(id), postcssMap, preprocessorMap),
        modules,
        deps
    };
}

//#region postCSS config

type PostCssConfig = {
    options: PostCss.ProcessOptions;
    plugins: PostCss.AcceptedPlugin[];
};
let postcssConfigCache: WeakMap<ResolvedConfig, PostCssConfig | undefined> = new WeakMap();

async function resolvePostcssConfig(config: ResolvedConfig): Promise<PostCssConfig | undefined> {
    let cacheResult = postcssConfigCache.get(config);

    if (cacheResult) {
        return cacheResult;
    }

    try {
        cacheResult = await loadPostcssConfig({}, config.root);
    } catch (e: any) {
        if (e.message.includes("No PostCSS Config found") === false) {
            throw new Error(logger.error(LOGTAG, `解析postcss配置文件出现问题，请核查`, e));
        }

        cacheResult = undefined;
    }

    postcssConfigCache.set(config, cacheResult);

    return cacheResult;
}

let processRules = new WeakSet<PostCss.Rule>();

const ANIMATION_NAME_RE = /^(-\w+-)?animation-name$/;
const ANIMATION_RE = /^(-\w+-)?animation$/;
function getPostCssScopedPlugin(id = ""): PostCss.Plugin {
    let attrId = `data-scoped-${id}`;
    let keyframes = Object.create(null);

    function isSpaceCombinator(node: postcssSelectorParser.Node) {
        return node.type === "combinator" && /^\s+$/.test(node.value);
    }
    return {
        postcssPlugin: "joker:scoped",
        Rule(rule) {
            if (
                processRules.has(rule) ||
                (rule.parent &&
                    rule.parent.type === "atrule" &&
                    /-?keyframes/.test((rule.parent as PostCss.AtRule).name))
            ) {
                return;
            }

            processRules.add(rule);

            rule.selector = postcssSelectorParser((selectorRoot) => {
                selectorRoot.each((selector) => {
                    let node: postcssSelectorParser.Node | undefined = undefined;
                    let isRootDeep = selector.first.type === "pseudo" && selector.first.value === ":deep";
                    selector.each((n) => {
                        if (n.type === "pseudo") {
                            if (n.value === ":deep") {
                                if (n.nodes.length) {
                                    let last: postcssSelectorParser.Selector["nodes"][0] = n;

                                    n.nodes[0].each((m) => {
                                        selector.insertAfter(last, m);

                                        last = m;
                                    });

                                    let prev = selector.at(selector.index(n) - 1);

                                    if (!prev || !isSpaceCombinator(n)) {
                                        selector.insertAfter(n, postcssSelectorParser.combinator({ value: "" }));
                                    }
                                    selector.removeChild(n);
                                } else {
                                    logger.warn(LOGTAG, `解析Scoped时，发现:deep()样式透传无参数，请检查`);

                                    let prev = selector.at(selector.index(n) - 1);

                                    if (prev && isSpaceCombinator(n)) {
                                        selector.removeChild(prev);
                                    }

                                    selector.removeChild(n);
                                }

                                return false;
                            }
                        }

                        //寻找最后一个节点
                        if (n.type !== "pseudo" && n.type !== "combinator") {
                            node = n;
                        }
                    });

                    if (!isRootDeep) {
                        if (node) {
                            (node as postcssSelectorParser.Node).spaces.after = "";
                        } else {
                            selector.first.spaces.before = "";
                        }

                        selector.insertAfter(
                            node as any,
                            postcssSelectorParser.attribute({
                                attribute: attrId,
                                value: attrId,
                                raws: {},
                                quoteMark: '"'
                            })
                        );
                    }
                });
            }).processSync(rule.selector);
        },
        AtRule(node) {
            if (/-?keyframes$/.test(node.name) && !node.params.endsWith(id)) {
                keyframes[node.params] = node.params = node.params + "-" + id;
            }
        },
        OnceExit(root, helper) {
            if (Object.keys(keyframes).length) {
                root.walkDecls((decl) => {
                    if (ANIMATION_NAME_RE.test(decl.prop)) {
                        decl.value = decl.value
                            .split(",")
                            .map((m) => keyframes[m.trim()] || m.trim())
                            .join(",");
                    }
                    if (ANIMATION_RE.test(decl.prop)) {
                        decl.value = decl.value
                            .split(",")
                            .map((m) => {
                                let vals = m.trim().split(/\s+/);
                                let i = vals.findIndex((val) => keyframes[val]);

                                if (i !== -1) {
                                    vals.splice(i, 1, keyframes[vals[i]]);
                                    return vals.join(" ");
                                }
                                return m;
                            })
                            .join(",");
                    }
                });
            }
        }
    };
}

//#endregion

//#region CSS语言类型
/**
 * 预处理语言
 */
const enum PREPROCESS_LAN {
    less = "less",
    sass = "sass",
    scss = "scss"
}

/**
 * 纯净CSS文件
 */
const enum PURECSS_LAN {
    css = "css"
}

type CSSLang = "css" | "less" | "sass" | "scss";

export function isPrePoscessor(lang: any): lang is PREPROCESS_LAN {
    return lang && lang in PREPROCESSORS;
}

let lessFillManager: any;

function createLessPlugin(less: typeof Less, options: StylePreprocessorOption, resolvers: CSSAtImportResolvers) {
    if (!lessFillManager) {
        lessFillManager = class JokerLessFillManager extends less.FileManager {
            constructor(public rootFile: string, public resolvers: CSSAtImportResolvers, public alias: Alias[]) {
                super();
            }

            override supports(
                filename: string,
                currentDirectory: string,
                options: Less.LoadFileOptions,
                environment: Less.Environment
            ): boolean {
                return true;
            }

            override supportsSync(
                filename: string,
                currentDirectory: string,
                options: Less.LoadFileOptions,
                environment: Less.Environment
            ): boolean {
                return false;
            }

            override async loadFile(
                filename: string,
                currentDirectory: string,
                options: Less.LoadFileOptions,
                environment: Less.Environment
            ): Promise<Less.FileLoadResult> {
                let resolved = await this.resolvers.less(filename, path.join(currentDirectory, "*"));

                if (resolved) {
                    let result = await rebaseUrls(resolved, this.rootFile, this.alias);

                    let contents = result.content;

                    return {
                        filename: path.resolve(resolved),
                        contents
                    };
                } else {
                    return super.loadFile(filename, currentDirectory, options, environment);
                }
            }
        };
    }

    let plugins: Less.Plugin[] = [
        {
            install(_, pluginManager) {
                pluginManager.addFileManager(new lessFillManager(options.filename, resolvers, options.alias));
            }
        },
        ...(options.plugins || [])
    ];

    return plugins;
}

const PREPROCESSORS = {
    [PREPROCESS_LAN.less]: async (
        source: string,
        root: string,
        options: StylePreprocessorOption,
        resolvers: CSSAtImportResolvers
    ): Promise<StylePreprocessorResult> => {
        let lessLoad = await loadPreprocessor(PREPROCESS_LAN.less, root);

        let { content, map: additionalMap } = await getSource(
            source,
            options.filename,
            options.additionalData,
            options.enableSourcemap
        );

        let result: Less.RenderOutput | undefined = undefined;
        let plugins = createLessPlugin(lessLoad, options, resolvers);
        try {
            result = await lessLoad.render(content, {
                ...options,
                plugins,
                ...(options.enableSourcemap
                    ? {
                          sourceMap: {
                              outputSourceFiles: true,
                              sourceMapFileInline: false
                          }
                      }
                    : {})
            });
        } catch (e) {
            let error = e as Less.RenderError;

            let normalizedError: RollupError = new Error(error.message || error.type);

            normalizedError.loc = {
                file: error.filename || options.filename,
                line: error.line,
                column: error.column
            };

            return { code: "", errors: [normalizedError], deps: [] };
        }

        let map: ExistingRawSourceMap = result.map && JSON.parse(result.map);

        if (map) {
            delete map.sourcesContent;
        }

        return {
            code: result.css.toString(),
            map,
            additionalMap,
            deps: result.imports,
            errors: []
        };
    },
    [PREPROCESS_LAN.sass]: async (
        source: string,
        root: string,
        options: StylePreprocessorOption,
        resolvers: CSSAtImportResolvers
    ): Promise<StylePreprocessorResult> => {
        return PREPROCESSORS[PREPROCESS_LAN.scss](source, root, options, resolvers);
    },
    [PREPROCESS_LAN.scss]: async (
        source: string,
        root: string,
        options: StylePreprocessorOption & StringOptions<"async">,
        resolvers: CSSAtImportResolvers
    ): Promise<StylePreprocessorResult> => {
        let scssLoader = await loadPreprocessor(PREPROCESS_LAN.sass, root);
        let importers: StringOptions<"async">["importers"] = [
            {
                async canonicalize(url, _options) {
                    let urlStr = decodeURIComponent(url.toString());
                    let resolved = await resolvers.sass(urlStr, options.filename);
                    if (resolved) {
                        return urlToFileURL(resolved);
                    }
                    return null;
                },
                async load(canonicalUrl) {
                    let urlStr = decodeURIComponent(canonicalUrl.pathname);

                    let result = await rebaseUrls(urlStr, options.filename, options.alias);

                    return {
                        contents: result.content,
                        sourceMapUrl: canonicalUrl,
                        syntax:
                            path.extname(result.file) === ".scss"
                                ? "scss"
                                : path.extname(result.file) === ".sass"
                                ? "indented"
                                : "css"
                    };
                }
            },
            ...(options.importers || [])
        ];

        let { content, map: additionalMap } = await getSource(
            source,
            options.filename,
            options.additionalData,
            options.enableSourcemap
        );

        let realOpt: StringOptions<"async"> = {
            ...options,
            importers,
            ...(options.enableSourcemap
                ? {
                      sourceMap: true,
                      omitSourceMapUrl: true,
                      sourceMapRoot: path.dirname(options.filename)
                  }
                : {})
        };

        try {
            let result = await scssLoader.compileStringAsync(content, realOpt);

            let map: ExistingRawSourceMap | undefined = result.sourceMap as unknown as ExistingRawSourceMap;

            return {
                code: result.css,
                map,
                additionalMap,
                errors: [],
                deps: result.loadedUrls.map((u) => decodeURIComponent(u.pathname))
            };
        } catch (e: any) {
            e.id = e.file;
            e.frame = e.formatted;

            return { code: "", errors: [e], deps: [] };
        }
    }
};

type StylePreprocessorOption = {
    [key: string]: any;
    additionalData?: PreprocessorAdditionalData;
    filename: string;
    alias: Alias[];
    enableSourcemap: boolean;
};

type StylePreprocessorResult = {
    code: string;
    map?: ExistingRawSourceMap | undefined;
    additionalMap?: ExistingRawSourceMap | undefined;
    errors: RollupError[];
    deps: string[];
};

type PreprocessorAdditionalData =
    | string
    | ((
          source: string,
          filename: string
      ) => PreprocessorAdditionalDataResult | Promise<PreprocessorAdditionalDataResult>);

type PreprocessorAdditionalDataResult = string | { content: string; map?: ExistingRawSourceMap };

interface Alias {
    find: string | RegExp;
    replacement: string;
    customResolver:
        | PluginHooks["resolveId"]
        | { buildStart?: PluginHooks["buildStart"]; resolveId: PluginHooks["resolveId"] }
        | null;
}

//处理器
let loadPreprocessorCache: Map<string, any> = new Map();
async function loadPreprocessor(lang: PREPROCESS_LAN.sass, root: string): Promise<typeof Sass>;
async function loadPreprocessor(lang: PREPROCESS_LAN.less, root: string): Promise<typeof Less>;
async function loadPreprocessor(lang: PREPROCESS_LAN, root: string): Promise<any> {
    if (loadPreprocessorCache.has(lang)) {
        return loadPreprocessorCache.get(lang);
    }
    try {
        let result: any;

        if (lang === PREPROCESS_LAN.sass) {
            result = await import(lang);
        } else {
            result = (await import(lang)).default;
        }
        loadPreprocessorCache.set(lang, result);

        return result;
    } catch (e: any) {
        if (e.code === "ERR_MODULE_NOT_FOUND") {
            throw new Error(
                logger.error(LOGTAG, `样式预处理程序包： "${lang}" 没有找到，请确定是否正确的安装了该依赖。`)
            );
        } else {
            const message = new Error(logger.error(LOGTAG, `样式预处理程序包 "${lang}" 加载失败:\n${e.message}`));
            message.stack = e.stack + "\n" + message.stack;
            throw message;
        }
    }
}
//#endregion

//#region  工具方法

/**
 * 重构内容中的Url
 * @param file
 * @param rootFile
 * @param alias
 * @returns
 */
async function rebaseUrls(file: string, rootFile: string, alias: Alias[]): Promise<{ file: string; content: string }> {
    file = path.resolve(file);

    let fileDir = path.dirname(file);
    let rootDir = path.dirname(rootFile);
    let content = fs.readFileSync(file, "utf-8");

    if (fileDir === rootDir) {
        return { file, content };
    }

    let hasUrls = CSS_URL_RE.test(content);
    let hasDataUris = CSS_DATA_URI_RE.test(content);
    let hasImport = IMPORT_CSS_RE.test(content);

    if (hasUrls === false && hasDataUris === false && hasImport === false) {
        return { file, content };
    }

    let rebaseFn = (url: string) => {
        if (url.startsWith("/")) return url;

        for (let { find } of alias) {
            let matches = typeof find === "string" ? url.startsWith(find) : find.test(url);

            if (matches) return url;
        }

        let absolute = path.resolve(fileDir, url);
        let relative = path.relative(rootDir, absolute);

        return normalizePath(relative);
    };

    if (hasImport) {
        content = await rewriteImportCss(content, rebaseFn);
    }

    if (hasUrls) {
        content = await rewriteCssUrls(content, rebaseFn);
    }

    if (hasDataUris) {
        content = await rewriteCssDataUris(content, rebaseFn);
    }

    return {
        file,
        content
    };
}

function rewriteImportCss(css: string, replacer: CssUrlReplacer): Promise<string> {
    return asyncReplace(css, IMPORT_CSS_RE, async (match) => {
        let [matched, rawUrl] = match;

        let wrap = "";
        let first = rawUrl[0];

        if (first === `"` || first === `'`) {
            wrap = first;
            rawUrl = rawUrl.slice(1, -1);
        }

        if (isExternalUrl(rawUrl) || isDataUrl(rawUrl) || rawUrl.startsWith("#")) {
            return matched;
        }

        return `@import ${wrap}${await replacer(rawUrl)}${wrap}`;
    });
}

function rewriteCssUrls(css: string, replacer: CssUrlReplacer): Promise<string> {
    return asyncReplace(css, CSS_URL_RE, async (match) => {
        let [matched, rawUrl] = match;

        return await doUrlReplace(rawUrl, matched, replacer);
    });
}

function rewriteCssDataUris(css: string, replacer: CssUrlReplacer): Promise<string> {
    return asyncReplace(css, CSS_DATA_URI_RE, async (match) => {
        let [matched, rawUrl] = match;

        return await doUrlReplace(rawUrl, matched, replacer, "data-uri");
    });
}

async function rewriteCssImageSet(css: string, replacer: CssUrlReplacer): Promise<string> {
    return await asyncReplace(css, CSS_IMAGE_SET_RE, async (match) => {
        let [, rawUrl] = match;

        return await transformSrcSetUrl(rawUrl, async (src) => {
            if (CSS_URL_RE.test(src.url)) {
                return await rewriteCssUrls(src.url, replacer);
            }

            if (/(gradient|element|cross-fade|image)\(/.test(src.url) === false) {
                return await doUrlReplace(src.url, src.url, replacer);
            }

            return src.url;
        });
    });
}

async function doUrlReplace(
    rawUrl: string,
    matched: string,
    replacer: CssUrlReplacer,
    funName: string = "url"
): Promise<string> {
    let wrap = "";
    let first = rawUrl[0];

    if (first === `"` || first === `'`) {
        wrap = first;
        rawUrl = rawUrl.slice(1, -1);
    }

    if (isExternalUrl(rawUrl) || isDataUrl(rawUrl) || rawUrl.startsWith("#") || /^var\(/i.test(rawUrl)) {
        return matched;
    }

    return `${funName}(${wrap}${await replacer(rawUrl)}${wrap})`;
}

async function getSource(
    source: string,
    filename: string,
    additionalData: PreprocessorAdditionalData | undefined,
    enableSourcemap: boolean,
    sep: string = ""
): Promise<Exclude<PreprocessorAdditionalDataResult, string>> {
    if (!additionalData) return { content: source };

    if (typeof additionalData === "function") {
        let newContent = await additionalData(source, filename);

        if (typeof newContent === "string") {
            return { content: newContent };
        }
        return newContent;
    }

    if (!enableSourcemap) {
        return { content: additionalData + sep + source };
    }

    let str = new MagicString(source);
    str.appendLeft(0, sep);
    str.appendLeft(0, additionalData);

    let map = str.generateMap({ hires: true });
    map.file = filename;
    map.sources = [filename];

    return {
        content: str.toString(),
        map
    };
}

function combineSourceMapsIfExists(
    filename: string,
    map1: ExistingRawSourceMap | undefined,
    map2: ExistingRawSourceMap | undefined
): ExistingRawSourceMap | undefined {
    return map1 && map2
        ? (combineSourceMaps(filename, [map1 as RawSourceMap, map2 as RawSourceMap]) as ExistingRawSourceMap)
        : map1;
}

export async function formatPostcssSourceMap(
    rawMap: ExistingRawSourceMap,
    file: string
): Promise<ExistingRawSourceMap> {
    let inputFileDir = path.dirname(file);

    let sources = rawMap.sources.map((source) => {
        let cleanSource = cleanUrl(decodeURIComponent(source));

        if (/^<.+>$/.test(cleanSource)) {
            return `\0${cleanSource}`;
        }

        return normalizePath(path.resolve(inputFileDir, cleanSource));
    });

    return {
        file,
        mappings: rawMap.mappings,
        names: rawMap.names,
        sources,
        sourcesContent: rawMap.sourcesContent,
        version: rawMap.version
    };
}

function createCSSResolvers(config: ResolvedConfig): CSSAtImportResolvers {
    return {
        get css() {
            return config.createResolver({
                extensions: [".css"],
                mainFields: ["style"],
                tryIndex: false,
                preferRelative: true
            });
        },
        get sass() {
            return config.createResolver({
                extensions: [".scss", ".sass", ".css"],
                mainFields: ["sass", "style"],
                tryIndex: true,
                tryPrefix: "_",
                preferRelative: true
            });
        },
        get less() {
            return config.createResolver({
                extensions: [".less", ".css"],
                mainFields: ["less", "style"],
                tryIndex: false,
                preferRelative: true
            });
        }
    };
}

export async function minifyCss(css: string, config: ResolvedConfig): Promise<string> {
    try {
        let { code, warnings } = await transform(css, {
            target: config.build.cssTraget,
            loader: "css",
            minify: true
        });

        if (warnings.length) {
            let msg = await formatMessages(warnings, { kind: "warning" });
            logger.warn(LOGTAG, `CSS压缩出现警告：\n${msg.join("\n")}`);
        }
        return code;
    } catch (e: any) {
        if (e.errors) {
            let msg = await formatMessages(e.errors, { kind: "error" });
            e.frame = "\n" + msg.join("\n");
            e.loc = e.errors[0].location;
        }

        throw e;
    }
}

/**
 * 最终优化CSS，包含提升以及压缩
 * @param css
 * @param minify
 * @param config
 * @returns
 */
export async function finalizeCss(css: string, minify: boolean, config: ResolvedConfig): Promise<string> {
    if (css.includes("@import") || css.includes("@charset")) {
        css = hoistAtRules(css);
    }

    if (minify && config.build.minify) {
        css = await minifyCss(css, config);
    }

    return css;
}

function hoistAtRules(css: string): string {
    let str = new MagicString(css);

    let cleanCss = clearCssComments(css);

    let match: RegExpExecArray | null;

    let atImportRE = /@import\s*(?:url\([^\)]*\)|"([^"]|(?<=\\)")*"|'([^']|(?<=\\)')*'|[^;]*).*?;/gm;

    while ((match = atImportRE.exec(cleanCss))) {
        str.remove(match.index, match.index + match[0].length);

        str.appendLeft(0, match[0]);
    }

    let atCharsetRE = /@charset\s*(?:"([^"]|(?<=\\)")*"|'([^']|(?<=\\)')*'|[^;]*).*?;/gm;

    let foundCharset = false;

    //剔除@charset标记，并统一追加到首行
    while ((match = atCharsetRE.exec(cleanCss))) {
        str.remove(match.index, match.index + match[0].length);

        if (foundCharset === false) {
            str.prepend(match[0]);

            foundCharset = true;
        }
    }

    return str.toString();
}

//#endregion
