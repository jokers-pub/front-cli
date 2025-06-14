import { ASSET_TYPES, CLIENT_PLUBLIC_PATH, ResolvedConfig } from "../config";
import glob from "fast-glob";
import path from "node:path";
import { cleanUrl, isEmptyStr, isObject, URL_DATA_RE, URL_EXTERNAL_RE } from "@joker.front/shared";
import { logger } from "../logger";
import {
    COMMENT_RE,
    CSS_LANG_RE,
    HTML_TYPES_RE,
    moduleListContains,
    MULTI_LINE_COMMENT_RE,
    normalizePath,
    OPTIMIZABLE_ENTRY_RE,
    prettifyUrl,
    SCRIPT_TYPES_RE,
    SINGLE_LINE_COMMENT_RE,
    SPECIAL_QUERT_RE
} from "../utils";
import fs from "node:fs";
import { build, Loader, OnLoadResult, Plugin, PluginBuild } from "esbuild";
import { PluginContainer } from "../server/pluginContainer";

const LOGTAG = "SCAN";

const VIRTUAL_MODULE_RE = /^virtual-module:.*/;
const VIRTUAL_MODULE_PRE_FIX = "virtual-module:";

const SCRIPT_MODULE_FOR_HTML_RE = /(<script\b[^>]*type\s*=\s*(?:"module"|'module')[^>]*>)(.*?)<\/script>/gims;
const SCRIPT_MODULE_FOR_JOKER_RE = /(<script\b(?:\s[^>]*>|>))(.*?)<\/script>/gims;

const SRC_RE = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/im;
const TYPE_RE = /\btype\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/im;
const LANG_RE = /\blang\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/im;

const IMPORT_RE =
    /(?<!\/\/.*)(?<=^|;|\*\/)\s*import(?!\s+type)(?:[\w*{}\n\r\t, ]+from\s*)?\s*("[^"]+"|'[^']+')\s*(?=$|;|\/\/|\/\*)/gm;

export async function scanProject(config: ResolvedConfig): Promise<{
    deps: Record<string, string>;
    missing: Record<string, string>;
}> {
    let entries: string[] = [];
    let buildInput = config.build.rollupOptions?.input;
    if (buildInput) {
        let resolvePath = (p: string) => path.resolve(config.root, p);
        if (typeof buildInput === "string") {
            entries = [resolvePath(buildInput)];
        } else if (Array.isArray(buildInput)) {
            entries = buildInput.map(resolvePath);
        } else if (isObject(buildInput)) {
            entries = Object.values(buildInput).map(resolvePath);
        } else {
            logger.error(LOGTAG, "Invalid type provided for rollupOptions.input");
        }
    } else {
        entries = await searchEntries("**/*.html", config);
    }

    entries = entries
        .map((m) => {
            if (SCRIPT_TYPES_RE.test(m) || HTML_TYPES_RE.test(m)) {
                if (fs.existsSync(m)) {
                    return m;
                } else {
                    logger.error(LOGTAG, `Entry scan failed: ${m} => File does not exist`);
                }
            } else {
                logger.error(LOGTAG, `Entry scan failed: ${m} => Unsupported file type (expected script or HTML)`);
            }
            return null;
        })
        .filter(Boolean) as string[];

    if (entries.length === 0) {
        logger.warn(LOGTAG, "No matching build entries found. Skipping dependency scan and proceeding to next step.");
        return {
            deps: {},
            missing: {}
        };
    }

    logger.debug(
        LOGTAG,
        `Build entry scan completed. Found ${entries.length} entries:\n  ${entries
            .map((m) => prettifyUrl(m, config.root))
            .join("\n  ")}`
    );

    let pluginContainer = new PluginContainer(config);

    let deps: Record<string, string> = {};
    let missing: Record<string, string> = {};

    let esBuildPlugin = EsbuildDepScanPlugin(entries, pluginContainer, deps, missing);

    let rollupResults = entries.map((entry) => {
        return build({
            absWorkingDir: process.cwd(),
            write: false,
            entryPoints: [entry],
            bundle: true,
            format: "esm",
            logLevel: "error",
            plugins: [esBuildPlugin]
        }).catch((e) => {
            logger.error(LOGTAG, `Error scanning entry ${entry}: ${e.message}`, e);
        });
    });

    await Promise.all(rollupResults);

    return {
        deps: orderDeps(deps),
        missing: missing
    };
}

function orderDeps(deps: Record<string, string>): Record<string, string> {
    let depList = Object.entries(deps);

    depList.sort((a, b) => a[0].localeCompare(b[0]));

    return Object.fromEntries(depList);
}

function searchEntries(pattern: string | string[], config: ResolvedConfig) {
    return glob(pattern, {
        cwd: config.root,
        ignore: ["**/node_modules/**", `**/${config.build.outDir}/**`, "**/__test__/**", "**/coverage/**"],
        absolute: true
    });
}

function EsbuildDepScanPlugin(
    entries: string[],
    pluginContainer: PluginContainer,
    deps: Record<string, string>,
    missing: Record<string, string>
): Plugin {
    let resolvedIds = new Map<string, string | undefined>();

    async function resolve(
        id: string,
        importer?: string,
        options?: Parameters<PluginContainer["resolveId"]>[2]
    ): Promise<string | undefined> {
        let key = id + (importer && path.dirname(importer));

        if (resolvedIds.has(key)) {
            return resolvedIds.get(key);
        }

        let resolved = await pluginContainer.resolveId(id, importer && normalizePath(importer), {
            ...options,
            scan: true
        });

        let resId = resolved?.id;

        resolvedIds.set(key, resId);

        return resId;
    }

    function extractImportPaths(code: string): string {
        let result = "";

        code = code.replace(MULTI_LINE_COMMENT_RE, "/* */");
        code = code.replace(SINGLE_LINE_COMMENT_RE, "");

        let m;

        while ((m = IMPORT_RE.exec(code)) != null) {
            //使其超出索引，终止本次match，避免死循环
            if (m.index === IMPORT_RE.lastIndex) {
                IMPORT_RE.lastIndex++;
            }

            result += `\nimport ${m[1]}`;
        }

        return result;
    }

    function externalUnlessEntry({ path }: { path: string }) {
        return {
            path,
            external: !entries.includes(path)
        };
    }

    /**
     * 检查当前resolved是否需要排除在外
     * @param resolved
     * @param id
     * @returns
     */
    function checkExternaUnlessResolved(resolved: string, id: string): boolean {
        //不是合法地址
        if (path.isAbsolute(resolved) === false) return true;

        if (resolved === id || resolved.includes("\0")) return true;

        return false;
    }

    function checkResolvedTypeEnable(resolveId: string): boolean {
        return SCRIPT_TYPES_RE.test(resolveId) || HTML_TYPES_RE.test(resolveId);
    }

    return {
        name: "joker:dep-scan",
        setup(build: PluginBuild): void | Promise<void> {
            let scripts: Record<string, OnLoadResult> = {};

            //外部链接
            build.onResolve({ filter: URL_EXTERNAL_RE }, ({ path }) => ({
                path,
                external: true
            }));

            //data 链接
            build.onResolve({ filter: URL_DATA_RE }, ({ path }) => ({
                path,
                external: true
            }));

            //<script></script> 虚拟节点
            build.onResolve({ filter: VIRTUAL_MODULE_RE }, ({ path }) => {
                return {
                    path: path.replace(VIRTUAL_MODULE_PRE_FIX, ""),
                    namespace: "script"
                };
            });

            //文件过滤-返回转换后的新资源
            build.onLoad({ filter: /.*/, namespace: "script" }, ({ path }) => {
                return scripts[path];
            });

            //html 扫描
            build.onResolve({ filter: HTML_TYPES_RE }, async ({ path, importer }) => {
                let resolved = await resolve(path, importer);

                /**
                 * 如果当前文件时script类型，并且在node_modules时，则跳过该扫描，交由其他程序进行dep类型标记
                 * 而不是标记为html namespace
                 */
                if (resolved && resolved.includes("node_modules") && OPTIMIZABLE_ENTRY_RE.test(resolved)) {
                    return;
                }

                return {
                    path: resolved,
                    namespace: "html"
                };
            });

            //对html中script进行扫描，并收集scripts
            build.onLoad({ filter: HTML_TYPES_RE, namespace: "html" }, async ({ path }) => {
                path = cleanUrl(path);
                let js = "";
                let raw = fs.readFileSync(path, "utf-8");
                //清空注释内容，避免接下来的正则匹配到注释内的资源
                raw = raw.replace(COMMENT_RE, "<!---->");
                //选定不通的匹配正则
                let scriptRegex = path.endsWith(".html") ? SCRIPT_MODULE_FOR_HTML_RE : SCRIPT_MODULE_FOR_JOKER_RE;

                let matchResult: RegExpExecArray | null;
                let scriptId = 0;

                while ((matchResult = scriptRegex.exec(raw))) {
                    let [, openTag, content] = matchResult;

                    let typeMatch = openTag.match(TYPE_RE);
                    let type = typeMatch && (typeMatch[1] || typeMatch[2] || typeMatch[3]);

                    let langMatch = openTag.match(LANG_RE);
                    let lang = langMatch && (langMatch[1] || langMatch[2] || langMatch[3]);

                    if (type && (type.includes("javascript") || type === "module") === false) {
                        continue;
                    }

                    let loader: Loader = "js";
                    //joker默认为ts语法
                    if (lang === "ts" || path.endsWith(".joker")) {
                        loader = "ts";
                    }

                    let srcMatch = openTag.match(SRC_RE);
                    if (srcMatch) {
                        js += `import ${JSON.stringify(srcMatch[1] || srcMatch[2] || srcMatch[3])};\n`;
                    } else if (isEmptyStr(content) === false) {
                        /**
                         * 如果在html中使用script，lang=ts时，esbuild在编译时会抛弃这些引用
                         * 需要我们先去收集这些依赖，然后存储到scripts中，待resolve：script时，进行返回
                         */
                        let contents = content + (loader === "ts" ? extractImportPaths(content) : "");

                        let key = `${path}?id=${scriptId++}`;

                        scripts[key] = {
                            loader,
                            contents,
                            pluginData: {
                                htmlType: { loader }
                            }
                        };

                        //添加引号
                        let virtualModulePath = JSON.stringify(VIRTUAL_MODULE_PRE_FIX + key);

                        js += `export * from ${virtualModulePath};\n`;
                    }
                }

                //添加default export
                if (path.endsWith(".joker") || js.includes("export default") === false) {
                    js += "\nexport default {}";
                }

                return {
                    loader: "js",
                    contents: js
                };
            });

            //对引用路径解析
            build.onResolve({ filter: /^[\w@][^:]/ }, async ({ path: id, importer }) => {
                //已存在 ｜｜ 需要排除
                if (deps[id] || moduleListContains([CLIENT_PLUBLIC_PATH], id)) {
                    return externalUnlessEntry({ path: id });
                }

                let resolvedId = await resolve(id, importer);
                if (resolvedId) {
                    if (checkExternaUnlessResolved(resolvedId, id)) {
                        return externalUnlessEntry({ path: id });
                    }

                    if (resolvedId.includes("node_modules")) {
                        if (OPTIMIZABLE_ENTRY_RE.test(resolvedId)) {
                            deps[id] = resolvedId;
                        }
                    } else if (checkResolvedTypeEnable(resolvedId)) {
                        return {
                            path: path.resolve(resolvedId),
                            namespace: HTML_TYPES_RE.test(resolvedId) ? "html" : undefined
                        };
                    }

                    return externalUnlessEntry({ path: id });
                } else {
                    missing[id] = normalizePath(importer);
                }
            });

            //排除样式(只考虑通用引用，不考虑SFC动态转换)
            build.onResolve({ filter: CSS_LANG_RE }, externalUnlessEntry);

            //排除json文件
            build.onResolve({ filter: /\.json$/ }, externalUnlessEntry);

            //排除静态资源
            build.onResolve({ filter: new RegExp(`\\.(${ASSET_TYPES.join("|")})$`) }, externalUnlessEntry);

            //将webworker等链接作为外部处理
            build.onResolve({ filter: SPECIAL_QUERT_RE }, ({ path }) => ({
                path,
                external: true
            }));

            //兜底未匹配的其他资源
            build.onResolve({ filter: /.*/ }, async ({ path: id, importer, pluginData }) => {
                let resolvedResult = await resolve(id, importer, {
                    custom: {
                        depScan: {
                            //html&underfind  由html内的script产生
                            loader: pluginData?.htmlType?.loader
                        }
                    }
                });

                if (resolvedResult) {
                    if (
                        checkExternaUnlessResolved(resolvedResult, id) ||
                        checkResolvedTypeEnable(resolvedResult) === false
                    ) {
                        return externalUnlessEntry({ path: id });
                    }

                    return {
                        path: path.resolve(cleanUrl(resolvedResult)),
                        namespace: HTML_TYPES_RE.test(resolvedResult) ? "html" : undefined
                    };
                }

                return externalUnlessEntry({ path: id });
            });

            //对脚本类型做加载
            build.onLoad({ filter: SCRIPT_TYPES_RE }, ({ path: id }) => {
                let ext = path.extname(id).slice(1);

                return {
                    loader: ext === "ts" ? "ts" : "js",
                    contents: fs.readFileSync(id, "utf-8")
                };
            });
        }
    };
}
