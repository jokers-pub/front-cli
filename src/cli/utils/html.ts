import { TemplateParser, RootNode, Node, ElementNode, NodeType, ElementAttr } from "@joker.front/sfc";
import { logger } from "../logger";
import { Server } from "../server";
import { Plugin } from "../plugin";
import { OutputBundle, OutputChunk } from "rollup";
import { ResolvedConfig } from "../config";
const LOGTAG = "HTML Transformation";

export function parserHtml(html: string): RootNode {
    let astParser = new TemplateParser(html, {
        keepComment: false,
        onWarn(msg, content) {
            logger.warn(LOGTAG, `AST template transformation warning: ${msg}; ${JSON.stringify(content)}`);
        }
    });

    return astParser.root;
}

export type HtmlTagDescriptor = {
    tag: string;
    attrs?: Record<string, any>;
    children?: string | HtmlTagDescriptor[];
    /**
     * 注入位置
     * head body默认采取后置注入，如果需要前置注入可以使用pre标记
     */
    to?: "head" | "body" | "head-pre" | "body-pre";
};

export type IndexHtmlTransformOption = {
    path: string;
    fileName: string;
    config: ResolvedConfig;
    chunk?: OutputChunk;
    bundle?: OutputBundle;
    originalUrl?: string;
    server?: Server;
};

/**
 * 需要解析URL的节点
 */
export const NEAD_TRANSFORM_URL_TAGS: Record<string, string[]> = {
    link: ["href"],
    vido: ["src", "poster"],
    source: ["src", "srcset"],
    img: ["src", "srcset"],
    image: ["href", "xlink:href"],
    use: ["href", "xlink:href"]
};

export type IndexHtmlTransformResult = string | HtmlTagDescriptor[] | { content: string; tags: HtmlTagDescriptor[] };

export type IndexHtmlTransformHook = (
    content: string,
    option: IndexHtmlTransformOption
) => IndexHtmlTransformResult | void | Promise<IndexHtmlTransformResult | void>;

export type IndexHtmlTransform =
    | IndexHtmlTransformHook
    | {
          enforce?: Plugin["enforce"];
          transform: IndexHtmlTransformHook;
      };

export function getHtmlTrasnfroms(plugins: Plugin[]): IndexHtmlTransformHook[][] {
    let pre: IndexHtmlTransformHook[] = [htmlEnvHook];
    let post: IndexHtmlTransformHook[] = [];

    //indexhtml hooks 不使用plugin的 enforce， 它属于局部的html的功能扩展
    //不属于整个插件的周期
    for (let plugin of plugins) {
        let hook = plugin.indexHtmlTransform;

        if (hook) {
            //不指定则按照post处理
            if (typeof hook === "function") {
                post.push(hook);
            } else if (hook.enforce === "pre") {
                pre.push(hook.transform);
            } else {
                post.push(hook.transform);
            }
        }
    }

    return [pre, post];
}

export async function transformHtml(
    content: string,
    hooks: IndexHtmlTransformHook[],
    option: IndexHtmlTransformOption
): Promise<string> {
    for (let hook of hooks) {
        let res = await hook(content, option);

        if (!res) {
            continue;
        }

        if (typeof res === "string") {
            content = res;
        } else {
            let tags: HtmlTagDescriptor[];

            if (Array.isArray(res)) {
                tags = res;
            } else {
                content = res.content || content;
                tags = res.tags;
            }

            let headTags: HtmlTagDescriptor[] = [];
            let headPreTags: HtmlTagDescriptor[] = [];
            let bodyTags: HtmlTagDescriptor[] = [];
            let bodyPreTags: HtmlTagDescriptor[] = [];
            //一次一次注入，不可采用集中式注入
            //注入后会更改content
            for (let tag of tags) {
                switch (tag.to) {
                    case "body":
                        bodyTags.push(tag);
                        break;
                    case "body-pre":
                        bodyPreTags.push(tag);
                        break;
                    case "head":
                        headTags.push(tag);
                        break;
                    case "head-pre":
                        headPreTags.push(tag);
                        break;
                }
            }

            content = injectToHtmlHead(content, headPreTags, true);
            content = injectToHtmlHead(content, headTags);
            content = injectToHtmlBody(content, bodyPreTags, true);
            content = injectToHtmlBody(content, bodyTags);
        }
    }

    return content;
}

let headPreInjectRE = /([ \t]*)<head[^>]*>/i;
let headInjectRE = /([ \t]*)<\/head>/i;
let htmlInjectRE = /<\/html>/i;
let bodyInjectRE = /([ \t]*)<\/body/i;
let bodyPreInjectRE = /([ \t]*)<body[^>]*>/i;

export function injectToHtmlHead(content: string, tags: HtmlTagDescriptor[], pre: boolean = false) {
    if (tags.length === 0) {
        return content;
    }

    if (pre) {
        //可以找到head前置
        if (headPreInjectRE.test(content)) {
            return content.replace(
                headPreInjectRE,
                (match, v) => `${match}\n${resolveTagsContent(tags, incrementIndent(v))}\n`
            );
        }
    } else {
        if (headInjectRE.test(content)) {
            return content.replace(
                headInjectRE,
                (match, v) => `${resolveTagsContent(tags, incrementIndent(v))}${match}\n`
            );
        }

        //如果没有body，则直接扔到body前面去
        if (bodyPreInjectRE.test(content)) {
            //这里不做递增indent，因为没有层级嵌套和body一级
            return content.replace(bodyPreInjectRE, (match, v) => `${resolveTagsContent(tags, v)}\n${match}\n`);
        }
    }

    //不做任何容错机制
    logger.error(
        LOGTAG,
        `Failed to inject tags. No valid insertion point found in <head>. Tags: ${JSON.stringify(tags)}`
    );
    return content;
}

function injectToHtmlBody(content: string, tags: HtmlTagDescriptor[], pre: boolean = false) {
    if (tags.length === 0) {
        return content;
    }

    if (pre) {
        if (bodyPreInjectRE.test(content)) {
            return content.replace(
                bodyPreInjectRE,
                (match, v) => `${match}\n${resolveTagsContent(tags, incrementIndent(v))}\n`
            );
        }

        //找不到body位置，则输出到head后面
        if (headInjectRE.test(content)) {
            return content.replace(headInjectRE, (match, v) => `${match}\n${resolveTagsContent(tags, v)}\n`);
        }

        //不做任何容错机制
        logger.error(
            LOGTAG,
            `Failed to inject tags. No valid insertion point found in <body>. Tags: ${JSON.stringify(tags)}`
        );
    } else {
        if (bodyInjectRE.test(content)) {
            return content.replace(
                bodyInjectRE,
                (match, v) => `${resolveTagsContent(tags, incrementIndent(v))}${match}\n`
            );
        }

        //如果没有body，则直接扔到html里面
        if (htmlInjectRE.test(content)) {
            return content.replace(htmlInjectRE, `${resolveTagsContent(tags)}\n$&`);
        }

        return content + "\n" + resolveTagsContent(tags);
    }

    return content;
}

function resolveTagsContent(tags: HtmlTagDescriptor["children"], indent: string = "") {
    if (typeof tags === "string") {
        return tags;
    } else if (tags?.length) {
        return tags
            .map((m) => {
                let result = indent;

                result += `<${m.tag}${resolveTagAttrContent(m.attrs)}>${resolveTagsContent(
                    m.children,
                    incrementIndent(indent)
                )}</${m.tag}>`;

                return result;
            })
            .join("");
    }
    return "";
}

function resolveTagAttrContent(attrs: HtmlTagDescriptor["attrs"]): string {
    let result = "";

    if (attrs) {
        for (let key in attrs) {
            let attrVal = attrs[key];

            if (typeof attrVal === "boolean") {
                attrVal && (result += ` ${key}`);
            } else {
                result += ` ${key}=${JSON.stringify(attrVal)}`;
            }
        }
    }
    return result;
}

function incrementIndent(indent: string = "") {
    return `${indent}${indent[0] === "\t" ? "\t" : "  "}`;
}

/**
 * 从根节点中过滤出所有Elemet节点，并通过callBack实现yield
 * @param pnode 父节点
 * @param callBack 回调
 */
export function filterAstElementNode(pnode: Node, callBack: (node: ElementNode) => void) {
    if (pnode.nodeType === NodeType.ELEMENT) {
        callBack(pnode as ElementNode);
    }

    if (pnode.childrens.length) {
        pnode.childrens.forEach((m) => {
            filterAstElementNode(m, callBack);
        });
    }
}

export function getScriptInfo(node: ElementNode): {
    src?: ElementAttr;
    module: boolean;
    async: boolean;
} {
    let result: {
        src?: ElementAttr;
        module: boolean;
        async: boolean;
    } = {
        module: false,
        async: false
    };
    node.attrs.forEach((a) => {
        let name = a.name.toLowerCase();
        if (name === "src") {
            result.src = a;
        } else if (name === "type" && a.value === "module") {
            result.module = true;
        } else if (name === "async") {
            result.async = true;
        }
    });

    return result;
}

export function htmlEnvHook(content: string, option: IndexHtmlTransformOption): string {
    let defines: Record<string, string>;
    defines ||= option.config.define;

    return content.replace(/%(\S+?)%/g, (text, key) => {
        if (key in defines) {
            return defines[key];
        }

        return text;
    });
}
