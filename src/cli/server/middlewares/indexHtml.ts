import { Server } from "..";
import fs from "node:fs";
import type { NextFunction } from "connect";
import type * as http from "node:http";

import path from "node:path";
import { logger } from "../../logger";
import { cleanUrl } from "@joker.front/shared";
import { addUrlTimerQuery, fsPathFromId, normalizePath, transformSrcSetUrlAsync } from "../../utils";

import {
    filterAstElementNode,
    IndexHtmlTransformOption,
    parserHtml,
    NEAD_TRANSFORM_URL_TAGS,
    transformHtml,
    IndexHtmlTransformResult,
    getHtmlTrasnfroms,
    getScriptInfo,
    htmlEnvHook
} from "../../utils/html";

import { CLIENT_PLUBLIC_PATH, FS_PREFIX, ID_PREFIX, NULL_BYTE_PLACHOLDER } from "../../config";
import { ElementAttr, ElementNode, NodeType, TextNode } from "@joker.front/sfc";
import MagicString, { SourceMap } from "magic-string";
import { addToHtmlProxyCache, getProxyEnd } from "../../plugins/html";

const LOGTAG = "IndexHtml-Middleware";

/**
 * 首页html处理中间件
 */
export class IndexHtmlMiddleware {
    constructor(protected server: Server) {
        //indexhtml 内容重构
        this.server.httpServer.app.use(this.indexHtml.bind(this));

        logger.debug(LOGTAG, "IndexHtml处理中间件初始化完成");
    }

    async indexHtml(req: http.IncomingMessage, res: http.ServerResponse, next: NextFunction) {
        if (res.writableEnded) {
            return next();
        }

        let url = req.url && cleanUrl(req.url);

        if (url?.endsWith(".html") && req.headers["sec-fetch-dest"] !== "script") {
            let fileName = this.getHtmlFilePath(url);

            if (fs.existsSync(fileName)) {
                try {
                    let htmlContent = fs.readFileSync(fileName, "utf-8");

                    let [preHooks, postHooks] = getHtmlTrasnfroms(this.server.config.plugins);
                    //交由 plugin中的hook进行再次加工处理
                    htmlContent = await transformHtml(
                        htmlContent,
                        [...preHooks, htmlEnvHook, this.transformIndexHtml.bind(this), ...postHooks],
                        {
                            path: url,
                            server: this.server,
                            originalUrl: (<any>req).originalUrl,
                            fileName: fileName,
                            config: this.server.config
                        }
                    );

                    return this.server.httpServer.send(req, res, htmlContent, "html", {
                        headers: this.server.config.server?.headers
                    });
                } catch (e) {
                    next(e);
                }
            }
        }

        next();
    }

    private getHtmlFilePath(url: string) {
        if (url.startsWith(FS_PREFIX)) {
            return decodeURIComponent(fsPathFromId(url));
        }
        return decodeURIComponent(normalizePath(path.join(this.server.config.root || "", url.slice(1))));
    }

    private async transformIndexHtml(
        content: string,
        option: IndexHtmlTransformOption
    ): Promise<IndexHtmlTransformResult> {
        let basePath = this.server.config.base || "/";

        let proxyModulePath: string;
        let proxyModuleUrl: string;

        if (option.path.endsWith("/")) {
            let validPath = `${option.path}index.html`;
            proxyModulePath = `\0${validPath}`;
            proxyModuleUrl = `${ID_PREFIX}${NULL_BYTE_PLACHOLDER}${validPath}`;
        } else {
            proxyModulePath = option.path;
            proxyModuleUrl = basePath + option.path.slice(1);
        }

        let proxyCacheUrl = cleanUrl(proxyModulePath).replace(normalizePath(this.server.config.root || ""), "");

        let html = new MagicString(content);

        let rootNode = parserHtml(content);

        let inlineModleIndex = 0;

        let styleNodes: TextNode[] = [];

        filterAstElementNode(rootNode, (node) => {
            if (node.tagName === "script") {
                let scriptInfo = getScriptInfo(node);

                if (scriptInfo.src) {
                    //做url转换
                    this.transformResouceUrl(scriptInfo.src, html, option.path, option.originalUrl!, true);
                } else if (scriptInfo.module && node.childrens.length) {
                    //添加内嵌script module
                    this.addInlineModule(
                        option.fileName,
                        html,
                        content,
                        node,
                        proxyCacheUrl,
                        proxyModulePath,
                        proxyModuleUrl,
                        inlineModleIndex++
                    );
                }
            } else if (node.tagName === "style" && node.childrens.length) {
                let cn = node.childrens[0];

                if (cn && cn.nodeType === NodeType.TEXT) {
                    //记录节点，并在循环外做css 的编译，编译是异步
                    styleNodes.push(cn as TextNode);
                }
            } else if (NEAD_TRANSFORM_URL_TAGS[node.tagName]) {
                for (let attr of node.attrs) {
                    if (attr.value && NEAD_TRANSFORM_URL_TAGS[node.tagName].includes(attr.name)) {
                        this.transformResouceUrl(attr, html, option.path, option.originalUrl!, false);
                    }
                }
            }
        });

        await Promise.all(
            styleNodes.map(async (node, index) => {
                let modulePath = proxyModuleUrl + getProxyEnd(false, true, index, "css");

                let module = await this.server.moduleMap.addEntryModuleUrl(modulePath, false);

                this.server.addWatchFile(module.file);

                let result = await this.server.pluginContainer.transform(node.text, module.id!);

                html.overwrite(node.position[0], node.position[1], result?.code || "");
            })
        );

        content = html.toString();
        return {
            content: content,
            tags: [
                {
                    tag: "script",
                    attrs: {
                        type: "module",
                        src: path.posix.join(basePath, CLIENT_PLUBLIC_PATH)
                    },
                    to: "head-pre"
                }
            ]
        };
    }

    private transformResouceUrl(
        attr: ElementAttr,
        html: MagicString,
        htmlPath: string,
        originalUrl: string,
        isScript: boolean
    ) {
        let url = attr.value;
        let basePath = this.server.config.base ?? "";
        //如果是script，则需要处理热更新时间戳问题
        if (isScript) {
            let moduleNode = this.server.moduleMap.urlModuleMap.get(url);

            //如果存在 && 已经发生过热更新，则地址后家最后推送时间以区分多版本
            if (moduleNode && moduleNode.lastHMRTimer) {
                url = addUrlTimerQuery(url, moduleNode.lastHMRTimer);
            }
        }

        //如果是以/开始，则转换相对路径
        if (/^\/(?!\/)/.test(url)) {
            html.overwrite(attr.start, attr.end, `${attr.name}="${basePath + url.slice(1)}"`, {
                contentOnly: true
            });
        } else if (url.startsWith(".") && originalUrl && originalUrl !== "/" && htmlPath === "/index.html") {
            let replaceExce = (urlStr: string) => {
                let url = path.posix.join(basePath, path.posix.relative(originalUrl, basePath), urlStr.slice(1));
                return `${attr.name}="${basePath + url.slice(1)}"`;
            };

            html.overwrite(
                attr.start,
                attr.end,
                attr.name === "srcset" ? transformSrcSetUrlAsync(url, (m) => replaceExce(m.url)) : replaceExce(url),
                {
                    contentOnly: true
                }
            );
        }
    }

    /**
     * 将页面script内嵌执行代码，转换为esm模式，并替换内容，转换到一个地址请求
     */
    private addInlineModule(
        fileName: string,
        html: MagicString,
        content: string,
        node: ElementNode,
        proxyCacheUrl: string,
        proxyModulePath: string,
        proxyModuleUrl: string,
        inlineModuleIndex: number
    ) {
        //一个html内可能存在多个inline的module，为了进行区分，使用index索引方式进行划分名称
        let childrenNode = node.childrens[0];

        if (childrenNode && childrenNode.nodeType === NodeType.TEXT) {
            let scriptContentNode = childrenNode as TextNode;
            let code = scriptContentNode.text;
            let map: SourceMap | undefined;

            if (proxyModulePath.startsWith("\0") === false) {
                map = new MagicString(content)
                    .snip(scriptContentNode.position[0], node.position[1])
                    .generateMap({ hires: true });
                map.sources = [fileName];
                map.file = fileName;
            }

            addToHtmlProxyCache(this.server.config, proxyCacheUrl, inlineModuleIndex, { code, map });

            let modulePath = proxyModuleUrl + getProxyEnd(false, false, inlineModuleIndex, "js");

            let module = this.server.moduleMap.getModuleById(modulePath);

            if (module) {
                //如果存在历史module，则先做销毁标记，等待htmlCache中重新请求编译
                this.server.moduleMap.disposeModule(module);
            }

            html.overwrite(node.position[0], node.position[1], `<script type="module" src="${modulePath}"></script>`, {
                contentOnly: true
            });
        }
    }
}
