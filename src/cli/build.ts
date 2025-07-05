import type { TransformOptions } from "esbuild";
import path from "node:path";
import type {
    InternalModuleFormat,
    LoggingFunction,
    ModuleFormat,
    OutputOptions,
    RollupBuild,
    RollupLog,
    RollupOptions,
    RollupOutput
} from "rollup";
import { ESBUILD_MODULES_TARGET, ResolvedConfig } from "./config";
import { logger } from "./logger";
import { rollup, Plugin as RollupPlugin } from "rollup";
import fs from "node:fs";
import { copyDir, emptyDir } from "./utils";
import { getPkgJson } from "./package";
import { isEmptyStr } from "@joker.front/shared";
const LOGTAG = "Build";

/**
 * 正在进行中的构建个数，用于在异常时进行逐一进程回收
 */
let doingBuildCallCounts = 0;
/**
 * 进行中的构建队列
 */
let doingBuilds: RollupBuild[] = [];
export interface BuildOptions {
    /**
     * Write bundles to disk
     * @default true
     */
    write?: boolean;

    /**
     * Browser compatibility target
     * @default '["es2020", "edge88", "firefox78", "chrome87", "safari13"]'
     */
    target?: TransformOptions["target"];

    /**
     * Customize underlying Rollup configuration
     */
    rollupOptions?: RollupOptions;

    /**
     * Output directory for build artifacts
     * @default 'dist'
     */
    outDir?: string;

    /**
     * Generate source maps for bundles
     */
    sourcemap?: boolean;

    /**
     * Directory (relative to outDir) to place generated assets
     * @default 'assets'
     */
    assetsDir?: string;

    /**
     * Inline assets below this size (in bytes) as base64 URLs
     * @default 4096
     */
    assetsInlineLimit?: number;

    /**
     * Minify output
     * @default 'esbuild'
     */
    minify?: boolean | "esbuild" | "terser";

    /**
     * Library mode options for building packages
     */
    lib?: LibraryOptions | false;

    /**
     * Warn when a chunk exceeds this size (in kilobytes)
     * @default 500
     */
    chunkSizeWarningLimit?: number;

    /**
     * CSS transformation target
     */
    cssTarget?: TransformOptions["target"];

    /**
     * Copy files from publicDir to outDir
     * @default true
     */
    copyPublicDir?: boolean;

    /**
     * Base URL for static asset serving
     */
    publicBaseDir?: string;

    /**
     * Options for terser
     * https://terser.org/docs/api-reference#minify-options
     */
    terserOptions?: any;

    /**
     * Options for worker bundles
     */
    worker?: {
        rollupOptions?: RollupOptions;
        plugins?: (input: string) => Promise<RollupPlugin>;
    };
}
export function resolveBuildOpt(config: Partial<ResolvedConfig>) {
    let resolevd: Required<BuildOptions> = {
        cssTarget: ESBUILD_MODULES_TARGET,
        target: ESBUILD_MODULES_TARGET,
        outDir: "dist",
        write: true,
        sourcemap: false,
        rollupOptions: {},
        assetsDir: "assets",
        assetsInlineLimit: 4096,
        minify: "esbuild",
        lib: false,
        chunkSizeWarningLimit: 500,
        copyPublicDir: true,
        publicBaseDir: "",
        worker: {},
        terserOptions: {}
    };

    Object.assign(resolevd, config.build ?? {});

    if (resolevd.minify === true) {
        resolevd.minify = "esbuild";
    }

    config.build = resolevd;
}

export interface LibraryOptions {
    /**
     * 入口文件
     */
    entry: string;
    /**
     * 别名
     */
    name?: string;
    /**
     * 输出类型
     * @default [es,umd]
     */
    formats?: LibraryFormatType[];

    /**
     * 输出文件名称，不配置则按原文件输出
     */
    fileName?: string | ((format: ModuleFormat) => string);
}

export type LibraryFormatType = "es" | "cjs" | "umd" | "iife";

/**
 * 构建主入口,控制主流程，支持并行多任务构建
 * @param config
 */
export async function build(config: ResolvedConfig): Promise<RollupOutput | RollupOutput[]> {
    doingBuildCallCounts++;

    try {
        return await doBuild(config);
    } finally {
        doingBuildCallCounts--;

        if (doingBuildCallCounts <= 0) {
            await Promise.all(doingBuilds.map((m) => m.close()));
            doingBuilds.length = 0;
        }
    }
}

async function doBuild(config: ResolvedConfig): Promise<RollupOutput | RollupOutput[]> {
    logger.info(LOGTAG, `Preparing to build project: ${config.root}`);

    let { build: options } = config;
    let resolve = (p: string) => path.resolve(config.root, p);

    //优先lib模式 -> rollup配置的入口 -> 根目录index.html
    let input = (options.lib ? resolve(options.lib.entry) : options.rollupOptions.input) || resolve("index.html");

    let outDir = resolve(options.outDir);

    let rollupOptions: RollupOptions = {
        context: "globalThis",
        preserveEntrySignatures: options.lib ? "strict" : false,
        ...options.rollupOptions,
        input,
        plugins: config.plugins,
        onwarn(warnings, warn) {
            onRollupWarning(config, warnings, warn);
        }
    };

    try {
        let outputs = transformBuildOutputs(options.rollupOptions.output, options.lib);

        let bundle = await rollup(rollupOptions);

        doingBuilds.push(bundle);

        if (config.build.write) {
            initOutDir(config, outDir);
        }
        if (Array.isArray(outputs)) {
            let result = [];
            for (let output of outputs) {
                result.push(
                    await bundle[config.build.write ? "write" : "generate"](
                        transformOutputOptions(config, outDir, output)
                    )
                );
            }

            return result;
        }

        return await bundle[config.build.write ? "write" : "generate"](transformOutputOptions(config, outDir, outputs));
    } catch (e: any) {
        let msg = "";
        if (e.plugin) {
            msg = `[${e.plugin}]`;
        }
        msg += e.message;

        if (e.id) {
            msg += `\nfile:${e.id + (e.loc ? `:${e.loc.line}:${e.loc.column}` : "")}`;
        }

        if (e.frame) {
            msg += `\n${e.frame}`;
        }

        logger.error(LOGTAG, msg);

        throw e;
    }
}

function initOutDir(config: ResolvedConfig, outDir: string) {
    //只有在需要输出时，才清空
    if (config.build.write && fs.existsSync(outDir)) {
        emptyDir(outDir);
        logger.debug(LOGTAG, `${outDir} directory has been cleared`);
    }

    //如果存在publicDir，则做copy处理
    if (config.publicDir && fs.existsSync(config.publicDir) && config.build.copyPublicDir) {
        copyDir(config.publicDir, outDir);
        logger.debug(LOGTAG, `${config.publicDir} has been copied to output directory`);
    }
}

function transformBuildOutputs(
    outputs: OutputOptions | OutputOptions[] | undefined,
    lib: ResolvedConfig["build"]["lib"]
) {
    if (lib) {
        let formats = lib.formats || ["es", "umd"];

        if ((formats.includes("umd") || formats.includes("iife")) && !lib.name) {
            throw new Error("Library name must be configured when using UMD or IIFE output formats");
        }

        if (outputs === undefined) {
            return formats.map((m) => ({ format: m }));
        } else if (Array.isArray(outputs) === false) {
            return formats.map((m) => ({ ...outputs, format: m }));
        } else if (lib.formats) {
            logger.warn(LOGTAG, "Ignoring lib.formats configuration because output options are explicitly defined");
        }
    }

    return outputs;
}

export function onRollupWarning(config: ResolvedConfig, warnings: RollupLog, warn: LoggingFunction) {
    //循环以来和未定义警告 做忽略
    if ([`CIRCULAR_DEPENDENCY`, `THIS_IS_UNDEFINED`].includes(warnings.code || "") === false) {
        if (config.build.rollupOptions.onwarn) {
            config.build.rollupOptions.onwarn(warnings, warn);
        } else if (warnings.code === "PLUGIN_WARNING") {
            logger.warn(LOGTAG, `[${warnings.plugin}]警告：${warnings.message}`);
        } else {
            warn(warnings);
        }
    }
}

function transformOutputOptions(config: ResolvedConfig, outDir: string, output: OutputOptions = {}): OutputOptions {
    let format = output.format || "es";
    let jsExt = config.build.lib ? transformOutputJsExtension(format, getPkgJson(config.root)?.type) : "js";

    return {
        dir: outDir,
        format,
        exports: "auto",
        sourcemap: config.build.sourcemap,
        name: config.build.lib ? config.build.lib.name : undefined,
        generatedCode: "es2015",
        entryFileNames: config.build.lib
            ? transformLibFileName(config.build.lib, format, config.root, jsExt)
            : path.posix.join(config.build.assetsDir, `[name].[hash].${jsExt}`),
        chunkFileNames: config.build.lib
            ? `[name].${jsExt}`
            : path.posix.join(config.build.assetsDir, `[name].[hash].${jsExt}`),
        assetFileNames: config.build.lib
            ? `[name].[ext]`
            : path.posix.join(config.build.assetsDir, `[name].[hash].[ext]`),
        inlineDynamicImports: output.format === "umd" || output.format === "iife",
        ...output
    };
}

function transformLibFileName(lib: LibraryOptions, format: ModuleFormat, root: string, extension?: JsExt): string {
    if (typeof lib.fileName === "function") {
        return lib.fileName(format);
    }

    let packageJson = getPkgJson(root);
    if (packageJson === undefined) {
        throw new Error("Failed to locate project package.json during build process");
    }

    let name = lib.fileName || (packageJson.name.startsWith("@") ? packageJson.name.split("/")[1] : packageJson.name);

    if (isEmptyStr(name)) {
        throw new Error(
            "No valid library name resolved for lib build. Please configure either lib.fileName or package.json#name"
        );
    }

    extension ??= transformOutputJsExtension(format, packageJson.type);

    if (format === "cjs" || format === "es") {
        return `${name}.${extension}`;
    }

    return `${name}.${format}.${extension}`;
}

type JsExt = "cjs" | "js" | "mjs";

function transformOutputJsExtension(format: ModuleFormat, type: string = "commonjs"): JsExt {
    if (type === "module") {
        return format === "cjs" || format === "umd" ? "cjs" : "js";
    }

    return format === "es" ? "mjs" : "js";
}

/**
 * 获取output文件路径
 * @returns 返回实际地址<string> 或者 返回runtime运行时执行语法
 */
export function toOutputFilePath<T>(
    filename: string,
    hostId: string,
    config: ResolvedConfig,
    toRelative: (fileName: string, hostId: string) => T
): T | string {
    let relative = config.base === "" || config.base === "./";

    if (relative) {
        return toRelative(filename, hostId);
    }

    return config.base + filename;
}

/*
  The following functions are copied from rollup
  https://github.com/rollup/rollup/blob/ce6cb93098850a46fa242e37b74a919e99a5de28/src/ast/nodes/MetaProperty.ts#L155-L203

  https://github.com/rollup/rollup
  The MIT License (MIT)
  Copyright (c) 2017 [these people](https://github.com/rollup/rollup/graphs/contributors)
  Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
  The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/
const needsEscapeRegEx = /[\n\r'\\\u2028\u2029]/;
const quoteNewlineRegEx = /([\n\r'\u2028\u2029])/g;
const backSlashRegEx = /\\/g;

function escapeId(id: string): string {
    if (!needsEscapeRegEx.test(id)) return id;
    return id.replace(backSlashRegEx, "\\\\").replace(quoteNewlineRegEx, "\\$1");
}

const getResolveUrl = (path: string, URL = "URL") => `new ${URL}(${path}).href`;

const getRelativeUrlFromDocument = (relativePath: string, umd = false) =>
    getResolveUrl(
        `'${escapeId(partialEncodeURI(relativePath))}', ${
            umd ? `typeof document === 'undefined' ? location.href : ` : ""
        }document.currentScript && document.currentScript.src || document.baseURI`
    );

const getFileUrlFromFullPath = (path: string) => `require('u' + 'rl').pathToFileURL(${path}).href`;

const getFileUrlFromRelativePath = (path: string) => getFileUrlFromFullPath(`__dirname + '/${escapeId(path)}'`);
function partialEncodeURI(uri: string): string {
    return uri.replaceAll("%", "%25");
}
const relativeUrlMechanisms: Record<InternalModuleFormat, (relativePath: string) => string> = {
    amd: (relativePath) => {
        if (relativePath[0] !== ".") relativePath = "./" + relativePath;
        return getResolveUrl(`require.toUrl('${escapeId(relativePath)}'), document.baseURI`);
    },
    cjs: (relativePath) =>
        `(typeof document === 'undefined' ? ${getFileUrlFromRelativePath(relativePath)} : ${getRelativeUrlFromDocument(
            relativePath
        )})`,
    es: (relativePath) => getResolveUrl(`'${escapeId(partialEncodeURI(relativePath))}', import.meta.url`),
    iife: (relativePath) => getRelativeUrlFromDocument(relativePath),
    // NOTE: make sure rollup generate `module` params
    system: (relativePath) => getResolveUrl(`'${escapeId(partialEncodeURI(relativePath))}', module.meta.url`),
    umd: (relativePath) =>
        `(typeof document === 'undefined' && typeof location === 'undefined' ? ${getFileUrlFromRelativePath(
            relativePath
        )} : ${getRelativeUrlFromDocument(relativePath, true)})`
};
/* end of copy */

export function createToImportMetaURLBasedRelativeRuntime(format: InternalModuleFormat) {
    let toRelativePath = relativeUrlMechanisms[format];

    return (filename: string, importer: string) => ({
        runtime: toRelativePath(path.posix.relative(path.dirname(importer), filename))
    });
}
