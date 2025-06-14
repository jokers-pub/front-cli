import { Plugin } from "../plugin";
import { ResolvedConfig } from "../config";
import MagicString, { SourceMap } from "magic-string";
import { cleanUrl, isDataUrl, isEmptyStr, isExternalUrl } from "@joker.front/shared";
import { getHash, getPublicFilePath, isCssRequest, normalizePath, slash, transformSrcSetUrl } from "../utils";
import { logger } from "../logger";
import {
    filterAstElementNode,
    getHtmlTrasnfroms,
    getScriptInfo,
    HtmlTagDescriptor,
    NEAD_TRANSFORM_URL_TAGS,
    parserHtml,
    transformHtml,
    injectToHtmlHead,
    htmlEnvHook
} from "../utils/html";
import path from "node:path";
import { toOutputFilePath } from "../build";
import { ElementAttr, NodeType, TextNode } from "@joker.front/sfc";
import { ASSET_URL_RE, getAssetFilename, urlToBuildUrl } from "./asset";
import { OutputChunk } from "rollup";
import { minify } from "html-minifier";
const LOGTAG = "plugin/html";
const HTML_PROXY_MAP: WeakMap<ResolvedConfig, Map<string, Array<{ code: string; map?: SourceMap }>>> = new WeakMap();
const ASYNC_SCRIPT_MAP: WeakMap<ResolvedConfig, Map<string, boolean>> = new WeakMap();
const INLINE_TRANSFORM_PLACEHOLDER_RE = /__JOKER_INLINE_CSS__([a-z\d]{8}_\d+)__/g;
const INLINE_TRANSFORM_PLACEHOLDER = "__JOKER_INLINE_CSS__";

/**
 * 是否是直接引用
 * @param code
 * @returns
 */
function isDirectImport(code: string): boolean {
    //import xxxxx
    return !code
        .replace(/\bimport\s*("[^"]*[^\\]"|'[^']*[^\\]');*/g, "")
        .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")
        .trim().length;
}

export const HTML_PROXY_RESULT = new Map<string, string>();

export function addToHtmlProxyCache(
    config: ResolvedConfig,
    filePath: string,
    index: number,
    value: { code: string; map?: SourceMap }
) {
    if (!HTML_PROXY_MAP.get(config)) {
        HTML_PROXY_MAP.set(config, new Map());
    }

    let proxyMap = HTML_PROXY_MAP.get(config)!;

    if (proxyMap.get(filePath) === undefined) {
        proxyMap.set(filePath, []);
    }

    proxyMap.get(filePath)![index] = value;
}

export function htmlInlineProxyPlugin(config: ResolvedConfig): Plugin {
    //重置缓存
    HTML_PROXY_MAP.set(config, new Map());

    return {
        name: "joker:html-inline-proxy",
        resolveId(source, importer, options) {
            if (isHtmlProxy(source)) {
                return source;
            }
        },
        load(id) {
            let proxyMatch = id.match(HTML_PROXY_RE);

            if (proxyMatch) {
                let index = Number(proxyMatch[1]);
                let file = cleanUrl(id);

                let url = file.replace(normalizePath(config.root), "");
                let result = HTML_PROXY_MAP.get(config)!.get(url)?.[index];

                if (result) {
                    return result;
                }

                throw new Error(logger.error(LOGTAG, `${id}: Proxy cache not found`));
            }
        }
    };
}

export function htmlBuildPlugin(config: ResolvedConfig): Plugin {
    let processedHtml = new Map<string, string>();

    let isExcludedUrl = (url: string) =>
        //#开头 || 外部链接 || data链接 || publicDir中的文件
        !!(url.startsWith("#") || isExternalUrl(url) || isDataUrl(url) || getPublicFilePath(config.publicDir, url));

    ASYNC_SCRIPT_MAP.set(config, new Map());

    return {
        name: "joker:html-build",

        async transform(html, id) {
            if (id.endsWith(".html") === false) return;

            let relativeUrlPath = slash(path.relative(config.root, id));
            let publicPath = `/${relativeUrlPath}`;
            let publicBase = getBaseInHtml(config.base, relativeUrlPath);

            let toOutPutPublicFilePath = (url: string) => {
                if (config.build.publicBaseDir) {
                    return normalizePath(config.build.publicBaseDir + "/" + url);
                }
                return toOutputFilePath<string>(url.slice(1), relativeUrlPath, config, (filename) => {
                    return publicBase + filename;
                });
            };

            let [preHooks] = getHtmlTrasnfroms(config.plugins);

            //前置转换
            html = await transformHtml(html, [...preHooks, htmlEnvHook], {
                path: publicPath,
                fileName: id,
                config
            });

            let js: string[] = [];
            let s = new MagicString(html);
            let inlineModuleIndex = -1;
            let styleUrls: { start: number; end: number; url: string }[] = [];
            let assetUrls: ElementAttr[] = [];
            let everyScriptIsAsync = true;
            let someScriptAreAsync = false;
            let someScriptAreDefer = false;

            let rootNode = parserHtml(html);
            let filePath = id.replace(normalizePath(config.root), "");

            //遍历节点收集数据
            filterAstElementNode(rootNode, (node) => {
                let shouldRemove = false;

                if (node.tagName === "script") {
                    let scriptInfo = getScriptInfo(node);

                    let url = scriptInfo.src && scriptInfo.src.value;
                    let isPublicFile = !!(url && getPublicFilePath(config.publicDir, url));

                    if (scriptInfo.src && isPublicFile) {
                        s.overwrite(
                            scriptInfo.src.valueStart!,
                            scriptInfo.src.end,
                            `"${toOutPutPublicFilePath(url!)}"`,
                            {
                                contentOnly: true
                            }
                        );
                    }

                    if (scriptInfo.module) {
                        inlineModuleIndex++;

                        //如果是module内部链接，则做排除做到主入口import
                        if (url && isExcludedUrl(url) === false) {
                            js.push(`import ${JSON.stringify(url)};`);
                            shouldRemove = true;
                        }
                        //无src有目录的，则把内容做成inline.js做入口import
                        else if (node.childrens.length) {
                            let childrenNode = node.childrens[0];
                            if (childrenNode && childrenNode.nodeType === NodeType.TEXT) {
                                let content = (<TextNode>childrenNode).text;

                                addToHtmlProxyCache(config, filePath, inlineModuleIndex, {
                                    code: content
                                });

                                js.push(`import "${id}${getProxyEnd(false, false, inlineModuleIndex, "js")}";`);
                                shouldRemove = true;
                            }
                        }
                        everyScriptIsAsync &&= scriptInfo.async;
                        someScriptAreAsync ||= scriptInfo.async;
                        someScriptAreDefer ||= !scriptInfo.async;
                    } else if (url && isPublicFile === false && isExcludedUrl(url) === false) {
                        logger.warn(
                            LOGTAG,
                            `<script src="${url}"> is not compiled. To include it in the build process, please use type='module'.`
                        );
                    }
                }

                // 通用标签内的地址引用转换
                if (NEAD_TRANSFORM_URL_TAGS[node.tagName]) {
                    for (let attr of node.attrs) {
                        if (attr.value && NEAD_TRANSFORM_URL_TAGS[node.tagName].includes(attr.name)) {
                            let url = decodeURI(attr.value);

                            if (isExcludedUrl(url) === false) {
                                //link样式请求
                                if (node.tagName === "link" && isCssRequest(url)) {
                                    styleUrls.push({
                                        start: node.position[0],
                                        end: node.position[1],
                                        url
                                    });
                                    js.push(`import ${JSON.stringify(url)};`);
                                } else {
                                    assetUrls.push(attr);
                                }
                            } else if (getPublicFilePath(config.publicDir, url)) {
                                s.overwrite(attr.valueStart!, attr.end, `"${toOutPutPublicFilePath(url)}"`, {
                                    contentOnly: true
                                });
                            }
                        }
                    }
                }

                //查找元素的style样式 && 具备url请求
                let inlineStyleAttr = node.attrs.find((attr) => {
                    return attr.name === "style" && attr.value && attr.value.includes("url(");
                });

                if (inlineStyleAttr) {
                    inlineModuleIndex++;

                    let styleContent = inlineStyleAttr.value;

                    addToHtmlProxyCache(config, filePath, inlineModuleIndex, { code: styleContent });

                    js.push(`import "${id}${getProxyEnd(true, false, inlineModuleIndex, "css")}";`);

                    let hash = getHash(cleanUrl(id));

                    s.overwrite(
                        inlineStyleAttr.valueStart!,
                        inlineStyleAttr.end,
                        `"${INLINE_TRANSFORM_PLACEHOLDER}${hash}_${inlineModuleIndex}__"`,
                        { contentOnly: true }
                    );
                }

                if (node.tagName === "style" && node.childrens.length) {
                    let contentNode = node.childrens[0] as TextNode;

                    let styleContent = contentNode.text;

                    inlineModuleIndex++;

                    addToHtmlProxyCache(config, filePath, inlineModuleIndex, {
                        code: styleContent
                    });

                    js.push(`import "${id}${getProxyEnd(true, false, inlineModuleIndex, "css")}";`);

                    let hash = getHash(cleanUrl(id));

                    s.overwrite(
                        contentNode.position[0],
                        contentNode.position[1],
                        `${INLINE_TRANSFORM_PLACEHOLDER}${hash}_${inlineModuleIndex}__`,
                        { contentOnly: true }
                    );
                }

                if (shouldRemove) {
                    s.remove(node.position[0], node.position[1]);
                }
            });

            ASYNC_SCRIPT_MAP.get(config)!.set(id, everyScriptIsAsync);
            if (someScriptAreAsync && someScriptAreDefer) {
                logger.warn(
                    LOGTAG,
                    `While collecting dependencies for ${id}, found script references with both defer and async attributes. This build will uniformly use async for entry references. Please ensure all script references are consistent.`
                );
            }

            //资源引用转换
            let namedOutput = Object.keys(config.build.rollupOptions.input || {});
            for (let attr of assetUrls) {
                let value = attr.value;

                let content = decodeURI(value);

                if (
                    //非空attr
                    isEmptyStr(content) === false &&
                    //是否时输入
                    namedOutput.includes(content) === false &&
                    namedOutput.includes(content.replace(/^\//, "")) === false
                ) {
                    try {
                        let url =
                            attr.name === "srcset"
                                ? await transformSrcSetUrl(content, ({ url }) => {
                                      return urlToBuildUrl(url, id, config, this);
                                  })
                                : await urlToBuildUrl(content, id, config, this);

                        s.overwrite(attr.valueStart!, attr.end, `"${url}"`, { contentOnly: true });
                    } catch (e: any) {
                        if (e.code !== "ENOENT") throw e;
                    }
                }
            }

            //样式引用转换
            let resolvedStyleUrl = await Promise.all(
                styleUrls.map(async (styleUrl) => {
                    return {
                        ...styleUrl,
                        resolved: await this.resolve(styleUrl.url, id)
                    };
                })
            );

            let jsStr = js.join("\n");
            for (let { start, end, url, resolved } of resolvedStyleUrl) {
                if (resolved === undefined || resolved === null) {
                    logger.warn(
                        LOGTAG,
                        `${url}: Not found during build time, ignoring to resolve on demand during runtime.`
                    );

                    let removeText = `import ${JSON.stringify(url)}`;

                    jsStr.replace(removeText, "");
                } else {
                    s.remove(start, end);
                }
            }

            let htmlStr = s.toString();
            htmlStr = minify(htmlStr, {
                collapseWhitespace: true,
                removeComments: true,
                minifyCSS: true,
                minifyJS: true
            });
            processedHtml.set(id, htmlStr);

            return jsStr;
        },

        async generateBundle(options, bundle) {
            let getImportedChunks = (chunk: OutputChunk, seen: Set<string> = new Set()): OutputChunk[] => {
                let chunks: OutputChunk[] = [];

                chunk.imports.forEach((file) => {
                    let importee = bundle[file];

                    if (importee.type === "chunk" && seen.has(file) === false) {
                        seen.add(file);

                        chunks.push(...getImportedChunks(importee, seen), importee);
                    }
                });

                return chunks;
            };

            //输出script标签
            let toScriptTag = (
                chunk: OutputChunk,
                toOutputPath: (filename: string) => string,
                isAsync: boolean
            ): HtmlTagDescriptor => {
                return {
                    tag: "script",
                    attrs: {
                        ...(isAsync ? { async: true } : {}),
                        type: "module",
                        crossorigin: true,
                        src: toOutputPath(chunk.fileName)
                    }
                };
            };
            let analyzedChunks: Map<OutputChunk, number> = new Map();
            let getCssTagsForChunk = (
                chunk: OutputChunk,
                toOutputPath: (filename: string) => string,
                seen: Set<string> = new Set()
            ): HtmlTagDescriptor[] => {
                let tags: HtmlTagDescriptor[] = [];
                if (analyzedChunks.has(chunk) === false) {
                    analyzedChunks.set(chunk, 1);

                    chunk.imports.forEach((file) => {
                        let importee = bundle[file];

                        if (importee.type === "chunk") {
                            tags.push(...getCssTagsForChunk(importee, toOutputPath, seen));
                        }
                    });
                }

                chunk.jokerMetadata.importedCss.forEach((file) => {
                    if (seen.has(file) === false) {
                        seen.add(file);

                        tags.push({
                            tag: "link",
                            attrs: {
                                rel: "stylesheet",
                                href: toOutputPath(file)
                            }
                        });
                    }
                });

                return tags;
            };
            //输出link[ref='modulepreload']
            let toPreloadTag = (chunk: OutputChunk, toOutputPath: (filename: string) => string): HtmlTagDescriptor => {
                return {
                    tag: "link",
                    attrs: {
                        rel: "modulepreload",
                        crossorigin: true,
                        href: toOutputPath(chunk.fileName)
                    }
                };
            };
            for (let [id, html] of processedHtml) {
                let relativeUrlPath = path.posix.relative(config.root, id);
                let assetsBase = getBaseInHtml(config.base, relativeUrlPath);

                let toOutputAssetFilePath = (filename: string) => {
                    if (isExternalUrl(filename)) {
                        return filename;
                    } else {
                        return toOutputFilePath(
                            filename,
                            relativeUrlPath,
                            config,
                            (filename, importer) => assetsBase + filename
                        );
                    }
                };

                let isAsync = !!ASYNC_SCRIPT_MAP.get(config)?.get(id);

                let chunk = Object.values(bundle).find(
                    (m) => m.type === "chunk" && m.isEntry && m.facadeModuleId === id
                ) as OutputChunk | undefined;

                let canInlineEntry = false;

                //向head中注入asset 引用script/link
                if (chunk) {
                    if (options.format === "es" && isDirectImport(chunk.code)) {
                        canInlineEntry = true;
                    }

                    let imports = getImportedChunks(chunk);
                    let assetTags = canInlineEntry
                        ? imports.map((m) => toScriptTag(m, toOutputAssetFilePath, isAsync))
                        : [
                              toScriptTag(chunk, toOutputAssetFilePath, isAsync),
                              ...imports.map((m) => toPreloadTag(m, toOutputAssetFilePath))
                          ];
                    assetTags.push(...getCssTagsForChunk(chunk, toOutputAssetFilePath));

                    html = injectToHtmlHead(html, assetTags);
                }

                //替换之前transform生成的标记位，转换后的内容来自css-plugin
                let match: RegExpExecArray | null;
                let s: MagicString | undefined;
                while ((match = INLINE_TRANSFORM_PLACEHOLDER_RE.exec(html))) {
                    s ||= new MagicString(html);

                    let { 0: full, 1: scopedName } = match;
                    let cssTransformoCode = HTML_PROXY_RESULT.get(scopedName);

                    if (cssTransformoCode === undefined) {
                        logger.error(LOGTAG, `Data loss occurred while parsing inline CSS: ${id}:${scopedName}`);
                        continue;
                    }

                    s.overwrite(match.index, match.index + full.length, cssTransformoCode, { contentOnly: true });
                }
                if (s) {
                    html = s.toString();
                }

                let [_, postHooks] = getHtmlTrasnfroms(config.plugins);

                //post hooks
                html = await transformHtml(html, postHooks, {
                    path: "/" + relativeUrlPath,
                    fileName: id,
                    bundle,
                    chunk,
                    config
                });

                //替换asset标记
                html = html.replace(ASSET_URL_RE, (_, fileHash, postfix = "") => {
                    return toOutputAssetFilePath(getAssetFilename(fileHash, config)!) + postfix;
                });

                //直接引用的入口，已经写入的html-inline中，所以做依赖排除
                if (chunk && canInlineEntry) {
                    delete bundle[chunk.fileName];
                }

                html = minify(html, {
                    collapseWhitespace: true,
                    removeComments: true,
                    minifyCSS: true,
                    minifyJS: true
                });

                //写回节点
                this.emitFile({
                    type: "asset",
                    fileName: path.relative(config.root, id),
                    source: html
                });
            }
        }
    };
}

function getBaseInHtml(base: string, urlRelativePath: string): string {
    return base === "./" || base === ""
        ? path.posix.join(path.posix.relative(urlRelativePath, "").slice(0, -2), "./")
        : base;
}

export function getProxyEnd(inlineCss: boolean, direct: boolean, index: number, ext: string): string {
    return (
        [`?html-proxy`, inlineCss ? "inline-css" : false, direct ? "direct" : false, `index=${index}`]
            .filter(Boolean)
            .join("&") + `.${ext}`
    );
}

const HTML_PROXY_RE = /\?html-proxy[&direct]*[&inline\-css]*&index=(\d+)\.(css|js)$/;

export function isHtmlProxy(id: string): boolean {
    return HTML_PROXY_RE.test(id);
}
