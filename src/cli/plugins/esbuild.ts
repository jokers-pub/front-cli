import { ResolvedConfig } from "../config";
import { Plugin } from "../plugin";
import { findAll, parse, TSConfckCache, TSConfckParseOptions, TSConfckParseResult } from "tsconfck";
import { searchForWorkspaceRoot } from "../root";
import { logger } from "../logger";
import { cleanUrl } from "@joker.front/shared";
import { Loader, Message, transform, TransformOptions, TransformResult } from "esbuild";
import type { InternalModuleFormat, SourceMap } from "rollup";
import path from "node:path";
import { Server } from "../server";
import { combineSourceMaps, generateCodeFrame, positionToOffset, toUpperCaseDriveLetter } from "../utils";
import type { RawSourceMap } from "@ampproject/remapping";
import colors from "picocolors";
import { HMRType } from "../server/hmr";

const LOGTAG = "plugin/esbuild";
const INJECT_HELPER_IIFE_RE = /^(.*)((?:const|var) [^\s]+=function\([^)]*?\){"use strict";)/s;
const INJECT_HELPER_UMD_RE = /^(.*)(\(function\([^)]*?\){.+amd.+function\([^)]*?\){"use strict";)/s;

let server: Server | undefined = undefined;
export function esbuildPlugin(config: ResolvedConfig): Plugin {
    return {
        name: "joker:esbuild",

        configureServer(_server: Server) {
            server = _server;
            server.watcher.on("add", reloadOnTsconfigChange);
            server.watcher.on("change", reloadOnTsconfigChange);
            server.watcher.on("unlink", reloadOnTsconfigChange);
        },

        buildEnd() {
            server = undefined;
        },

        async configTransform() {
            await initTsConfCk(config);
        },

        async transform(code, id) {
            let file = cleanUrl(id);

            if (/\.ts$/.test(file)) {
                let result = await transformWithEsbuild(code, id, {
                    target: "esnext",
                    minify: false,
                    loader: "ts",
                    minifyIdentifiers: false,
                    minifySyntax: false,
                    minifyWhitespace: false,
                    treeShaking: false,
                    keepNames: false
                });

                if (result.warnings.length) {
                    result.warnings.forEach((m) => {
                        logger.warn(LOGTAG, `ESBuild:transform警告：${file}\n${prettifyMessage(m, code)}`);
                    });
                }

                return {
                    code: result.code,
                    map: result.map
                };
            }
        }
    };
}

export function esbuildBuildPlugin(config: ResolvedConfig): Plugin {
    return {
        name: "joker:esbuild-build",
        async configTransform(config) {
            await initTsConfCk(config);
        },
        async renderChunk(code, chunk, opts) {
            //@ts-ignore 提供扩展
            if (opts.__joker_skip_esbuild__) return null;

            let options = transformEsbuildBuildOptions(config, opts.format);

            if (!options) {
                return null;
            }

            let res = await transformWithEsbuild(code, chunk.fileName, options);

            if (config.build.lib) {
                let injectHelper =
                    opts.format === "umd"
                        ? INJECT_HELPER_UMD_RE
                        : opts.format === "iife"
                        ? INJECT_HELPER_IIFE_RE
                        : undefined;
                if (injectHelper) {
                    res.code = res.code.replace(injectHelper, (_, helpers, header) => header + helpers);
                }
            }

            return res;
        }
    };
}

function prettifyMessage(m: Message, code: string): string {
    let res = colors.yellow(m.text);

    if (m.location) {
        let lines = code.split(/\r?\n/g);
        let line = Number(m.location.line);
        let column = Number(m.location.column);

        let offset =
            lines
                .slice(0, line - 1)
                .map((l) => l.length)
                .reduce((total, l) => total + l + 1, 0) + column;

        res += `\n` + generateCodeFrame(code, offset, offset + 1);
    }

    return res + "\n";
}

export type ESBuildTransformResult = Omit<TransformResult, "map"> & {
    map: SourceMap;
};

type TSConfigJSON = {
    extends?: string;
    compilerOptions?: {
        target?: string;
        jsxFactory?: string;
        jsxFragmentFactory?: string;
        useDefineForClassFields?: boolean;
        importsNotUsedAsValues?: "remove" | "preserve" | "error";
        preserveValueImports?: boolean;
    };
    [key: string]: any;
};
type TSCompilerOptions = NonNullable<TSConfigJSON["compilerOptions"]>;

export async function transformWithEsbuild(
    code: string,
    file: string,
    options?: TransformOptions,
    inMap?: object
): Promise<ESBuildTransformResult> {
    let loader = options?.loader;

    if (!loader) {
        let ext = path.extname(/\.\w+$/.test(file) ? file : cleanUrl(file)).slice(1);

        if (ext === "ts") {
            loader = "ts";
        } else if (ext === "cjs" || ext === "mjs" || ext === "js") {
            loader = "js";
        } else {
            logger.warn(LOGTAG, `${ext}未制定loader，采用后缀编译`);
            loader = ext as Loader;
        }
    }

    let tsconfigRaw = options?.tsconfigRaw;

    if (typeof tsconfigRaw !== "string") {
        let meningfulFields: Array<keyof TSCompilerOptions> = [
            "target",
            "jsxFragmentFactory",
            "jsxFactory",
            "useDefineForClassFields",
            "importsNotUsedAsValues",
            "preserveValueImports"
        ];

        let compilerOptionsForFile: TSCompilerOptions = {};

        if (loader === "ts") {
            let loadedTsConfig = await loadTsconfigJsonForFile(file);

            let loadedCompilerOptions = loadedTsConfig.compilerOptions ?? {};

            for (let field of meningfulFields) {
                if (field in loadedCompilerOptions) {
                    //@ts-ignore
                    compilerOptionsForFile[field] = loadedCompilerOptions[field];
                }
            }
        }

        tsconfigRaw = {
            ...tsconfigRaw,
            compilerOptions: {
                ...compilerOptionsForFile,
                ...tsconfigRaw?.compilerOptions
            }
        };
    }

    let resolvedOptions = {
        sourcemap: true,
        sourcefile: file,
        ...options,
        loader,
        tsconfigRaw
    };

    try {
        let result = await transform(code, resolvedOptions);
        let map: SourceMap;

        if (inMap && resolvedOptions.sourcemap) {
            let nextMap = JSON.parse(result.map);

            nextMap.sourcesContent = [];
            map = combineSourceMaps(file, [nextMap as RawSourceMap, inMap as RawSourceMap]) as SourceMap;
        } else {
            map = resolvedOptions.sourcemap ? JSON.parse(result.map) : { mappings: "" };
        }

        if (Array.isArray(map.sources)) {
            map.sources = map.sources.map((item) => toUpperCaseDriveLetter(item));
        }

        return {
            ...result,
            map
        };
    } catch (e: any) {
        if (e.errors) {
            for (let error of e.errors) {
                if (error.location) {
                    logger.error(LOGTAG, `代码转换失败:${error.text} \n${error.location.lineText}`);
                }
            }
            throw e;
        }

        logger.error(LOGTAG, `ESBuild代码转换失败：${file}`);
        throw e;
    }
}

let tsconfckParserOptions: TSConfckParseOptions = {
    cache: new TSConfckCache(),
    root: undefined,
    ignoreNodeModules: true
};

async function initTsConfCk(config: ResolvedConfig) {
    let workspaceRoot = searchForWorkspaceRoot(config.root);

    logger.debug(LOGTAG, `初始化tsConfig查询程序，workspace目录：${workspaceRoot}`);

    tsconfckParserOptions.cache?.clear();
    tsconfckParserOptions.root = workspaceRoot;

    logger.debug(LOGTAG, "tsconfig查询程序完成");
}

async function loadTsconfigJsonForFile(file: string): Promise<TSConfigJSON> {
    try {
        let result = await parse(file, tsconfckParserOptions);

        if (server && result.tsconfigFile !== "no_tsconfig_file_found") {
            server.addWatchFile(result.tsconfigFile);
        }

        return result.tsconfig;
    } catch (e) {
        throw e;
    }
}

/**
 * tsconfig可能在root之外，需要对其监听，新增、删除、更改，触发reload
 * @param changedFile
 */
function reloadOnTsconfigChange(changedFile: string) {
    if (
        server &&
        (path.basename(changedFile) === "tsconfig.json" ||
            (changedFile.endsWith(".json") && tsconfckParserOptions.cache?.hasParseResult(changedFile)))
    ) {
        logger.info(LOGTAG, `检测到tsconfig配置文件变动，需要触发reload`);

        server.moduleMap.disposeAllModule();

        initTsConfCk(server.config).finally(() => {
            server?.socketServer.send(new HMRType.Reload("*"));
        });
    }
}

function transformEsbuildBuildOptions(config: ResolvedConfig, format: InternalModuleFormat): TransformOptions | null {
    let target = config.build.target;
    let minify = config.build.minify === "esbuild";

    if ((!target || target === "esnext") && !minify) {
        return null;
    }

    let isEsLibBuild = config.build.lib && format === "es";

    let options: TransformOptions = {
        target: target || undefined,
        format: (
            {
                es: "esm",
                cjs: "cjs",
                iife: undefined
            } as Record<string, any>
        )[format],
        supported: {
            "dynamic-import": true,
            "import-meta": true
        }
    };

    if (minify === false) {
        return {
            ...options,
            minify: false,
            minifyIdentifiers: false,
            minifySyntax: false,
            minifyWhitespace: false,
            treeShaking: false
        };
    }

    if (isEsLibBuild) {
        return {
            ...options,
            minify: false,
            minifyIdentifiers: true,
            minifySyntax: true,
            minifyWhitespace: false,
            treeShaking: true
        };
    }

    return {
        ...options,
        minify: true,
        treeShaking: true
    };
}
