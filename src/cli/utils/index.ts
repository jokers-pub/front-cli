import path from "node:path";
import os from "node:os";
import dns from "node:dns";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { logger } from "../logger";
import crossSpawn from "cross-spawn";
import open from "open";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import type { RollupError, TransformResult, SourceMap as RollupSourceMap } from "rollup";
import color from "picocolors";
import type { DecodedSourceMap, RawSourceMap } from "@ampproject/remapping";
import { createFilter as _createFilter } from "@rollup/pluginutils";
import {
    DEFAULT_EXTENSIONS,
    FS_PREFIX,
    ID_PREFIX,
    INTERNAL_REQUEST,
    NULL_BYTE_PLACHOLDER,
    ResolvedConfig
} from "../config";
import remapping from "@ampproject/remapping";
import type SourceMap from "@ampproject/remapping/dist/types/source-map";
import { cleanUrl } from "@joker.front/shared";
import { promisify } from "node:util";
import resolve from "resolve";
import MagicString from "magic-string";

const LOGTAG = "utils";

export const isWindows = os.platform() === "win32";

//#region host / ip类操作
/**
 * 转换host
 * @param host
 * @returns host，name
 */
export async function transformHostName(host?: string | boolean): Promise<{ host: string; name: string }> {
    let result = {
        host: "",
        name: ""
    };

    if (host === undefined || host === false) {
        result.host = "localhost";
    } else if (typeof host === "string") {
        result.host = host;
    }

    //如果没有配置host 或者为通配符主机
    if (!result.host || WILDCARD_HOSTS.includes(result.host)) {
        result.name = "localhost";
    } else {
        result.name = result.host;
    }

    if (result.host === "localhost") {
        //如果是local， 则处理差异化dns的address
        let [nodeResult, dnsResult] = await Promise.all([
            dns.promises.lookup("localhost"),
            dns.promises.lookup("localhost", { verbatim: true })
        ]);

        if ((nodeResult.family === dnsResult.family && nodeResult.address === dnsResult.address) === false) {
            result.name = nodeResult.address;
        }
    }

    return result;
}

/**
 * 通配符主机
 */
export const WILDCARD_HOSTS = ["0.0.0.0", "::", "0000:0000:0000:0000:0000:0000:0000:0000"];

/**
 * 环回主机
 */
export const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1", "0000:0000:0000:0000:0000:0000:0000:0001"];
//#endregion

//#region  URL相关操作
export const NODE_MODULES_RE = /(^|\/)node_modules\//;

export const SPECIAL_QUERT_RE = /[\?&](?:worker|sharedworker|raw|url)\b/;

export const RAW_RE = /(\?|&)raw(?:&|$)/;

export const URL_RE = /(\?|&)url(?:&|$)/;

export const SCRIPT_TYPES_RE = /\.(?:j|t)s$|\.mjs$/;

export const OPTIMIZABLE_ENTRY_RE = /\.(?:(m|c)?js|ts)$/;

export const HTML_TYPES_RE = /\.(html|joker)$/;

export const DEP_VERSION_RE = /[\?&](v=[\w\.-]+)\b/;

export function getFileExtRegex(filter: string[]): RegExp {
    return new RegExp(`\\.(${filter.join("|")})(\\?.*)?$`);
}

export function getDepVersion(url: string): string | undefined {
    let versionMatch = url.match(DEP_VERSION_RE);
    if (versionMatch) {
        return versionMatch[1].split("=")[1];
    }
    return;
}

/**
 * 转换可识别规范的地址
 * @param strPath
 * @returns
 */
export function normalizePath(strPath: string): string {
    return path.posix.normalize(isWindows ? slash(strPath) : strPath);
}

export function slash(p: string): string {
    return p.replace(/\\/g, "/");
}

export function stripBase(url: string, base: string): string {
    if (url === base) return "/";

    let devBase = base;

    if (base[base.length - 1] !== "/") {
        devBase = `${base}/`;
    }

    return url.startsWith(devBase) ? url.slice(devBase.length - 1) : url;
}

export function ensureVolumeInPath(file: string): string {
    return isWindows ? path.resolve(file) : file;
}

/**
 * CLI当前类库的路径
 */
export const CLI_PACKAGE_DIR = path.resolve(
    ////当前脚本构建完毕后在dist/xxx
    __dirname,
    "../"
);

export const NODE_MODULE_DIR = path.resolve(CLI_PACKAGE_DIR, "../");

/**
 * 结尾？&匹配，用于删除url中参数时，再次对url进行规范操作
 * 例如：xxx.com?t=1; 删除t=1 后应该对？进行删除  &同理
 */
const trailingSeparatirRE = /[\?&]$/;

/**
 * 返回指定内容相同长度的空格替换符
 * @param str
 * @returns
 */
export function blankReplacer(str: string): string {
    return " ".repeat(str.length);
}

type SrcSetType = { url: string; descriptor: string };

function splitSrcSetDescriptor(srcs: string): SrcSetType[] {
    return srcs
        .split(",")
        .map((m) => {
            m = m.replace(/( |\\t|\\n|\\r)+/g, " ").trim();

            let url = (/^(?:[\w\-]+\(.*?\)|'.*?'|".*?"|\S*)/.exec(m) || [])[0];

            return {
                url: url ?? "",
                descriptor: (url && m.slice(url.length).trim()) ?? ""
            };
        })
        .filter((m) => m.url);
}

function jsonSrcSets(srcs: SrcSetType[]): string {
    return srcs.reduce((prev: string, curr: SrcSetType, index: number) => {
        curr.descriptor ??= "";

        return `${prev || ""}${curr.url} ${curr.descriptor}${index === srcs.length - 1 ? "" : ","}`;
    }, "");
}

/**
 * 转换 srcset中的url
 * @param srcSet
 * @param transformFn
 * @returns
 */
export function transformSrcSetUrlAsync(srcSet: string, transformFn: (srcs: SrcSetType) => string): string {
    return jsonSrcSets(
        splitSrcSetDescriptor(srcSet).map((m) => {
            return {
                url: transformFn(m),
                descriptor: m.descriptor
            };
        })
    );
}

export function transformSrcSetUrl(
    srcSet: string,
    transformFn: (srcs: SrcSetType) => Promise<string>
): Promise<string> {
    return Promise.all(
        splitSrcSetDescriptor(srcSet).map(async (m) => {
            return {
                url: await transformFn(m),
                descriptor: m.descriptor
            };
        })
    ).then((ret) => jsonSrcSets(ret));
}

export function urlToFileURL(url: string): URL {
    return new URL(url.replace(/%/g, "%25"), "file:///");
}

/**
 * 向URL中添加query参数
 * @param url
 * @param query
 * @returns
 */
export function addUrlQuery(url: string, query: string): string {
    let resolvedUrl = new URL(url.replace(/%/g, "%25"), "relative:///");

    if (resolvedUrl.protocol !== "relative:") {
        //@ts-ignore
        resolvedUrl = pathToFileURL(url);
    }

    let { protocol, pathname, search, hash } = resolvedUrl;
    if (protocol === "file:") {
        pathname = pathname.slice(1);
    }

    pathname = decodeURIComponent(pathname);

    return `${pathname}?${query}${search ? "&" + search.slice(1) : ""}${hash ?? ""}`;
}

/**
 * 向Url中添加热更新时间戳
 * @param url
 * @param timer
 * @returns
 */
export function addUrlTimerQuery(url: string, timer: number): string {
    return addUrlQuery(url, `t=${timer}`);
}

/**
 * 移除url中热更新时间戳
 * @param url
 */
export function removeTimestampQuery(url: string): string {
    return url.replace(/\bt=\d{13}&?\b/, "").replace(trailingSeparatirRE, "");
}

/**
 * 移除url中的import 以及query
 * @param url
 * @returns
 */
export function removeImportQuery(url: string): string {
    return url.replace(/(\?|&)import=?(?:&|$)/, "$1").replace(trailingSeparatirRE, "");
}

/**
 * 是否是import请求
 * @param url
 * @returns
 */
export function isImportRequest(url: string): boolean {
    return /(\?|&)import=?(?:&|$)/.test(url);
}

/**
 * 是否是内部请求
 * @param url
 */
export function isInternalRequest(url: string): boolean {
    return new RegExp(`^(?:${INTERNAL_REQUEST.join("|")})`).test(url);
}

/**
 * 是否是ts请求（不考虑 cmts｜tsx）
 * @param url
 */
export function isTSRequest(url: string): boolean {
    return /\.(ts)$/.test(url);
}
/**
 * ts可能输出的文件类型(不考虑cmjs｜jsx)
 * @param url
 * @returns
 */
export function isPossibleTsOutput(url: string): boolean {
    return /\.(js)$/.test(url);
}

/**
 * 根据输出，推导出可能的src源文件地址
 * @param filePath
 * @returns
 */
export function getPossibleTsSrcPath(filePath: string): string[] {
    let [name, type, query = ""] = filePath.split(/(\.(?:js))(\?.*)?$/);

    return [name + type.replace("js", "ts") + query];
}

/**
 * 是否是脚本文件请求，目前只支持js、ts、joker文件
 * @param url
 * @returns
 */
export function isJSRequest(url: string): boolean {
    if (/\.((j|t)s|joker)($|\?)/.test(url)) {
        return true;
    }
    //e.g. import 'xxxx/xxx/index'
    if (!path.extname(url) && url.endsWith("/") === false) {
        return true;
    }
    return false;
}

export function isInNodeModules(id: string): boolean {
    return id.includes("node_modules");
}

export function isJSONRequest(url: string): boolean {
    return /.json($|\?)/.test(url);
}

export function isHTMLRequest(url: string): boolean {
    return /\.(html|htm)$/.test(url);
}

export const JS_EXTENSION_RE = /\.js$/i;

export const JS_MAP_EXTENSION_RE = /\.js\.map$/i;

//这里使用全样式文件类型，目的是对资源类型进行区分
export const CSS_LANG_ARRAY = ["css", "less", "sass", "scss"];
export const CSS_LANG = `\\.(${CSS_LANG_ARRAY.join("|")})($|\\?)`;
export const CSS_LANG_RE = new RegExp(CSS_LANG);

//补充CSS匹配
export const SHIMS_CSS_LANG = `(\\&|\\?)lang=(${CSS_LANG_ARRAY.join("|")})($|\\&)`;
export const SHIMS_CSS_LANG_RE = new RegExp(SHIMS_CSS_LANG);

/**
 * 是否是样式文件请求
 * @param url
 */
export function isCssRequest(url: string): boolean {
    return CSS_LANG_RE.test(url) || SHIMS_CSS_LANG_RE.test(url);
}

export function isDirectCssRequest(request: string): boolean {
    return isCssRequest(request) && isDirectRequest(request);
}

/**
 * 是否是dep请求，dep请求具有v=hash的特性
 * @param url
 * @returns
 */
export function isDepRequest(url: string): boolean {
    return /[\?&](v=[\w\.-]+)\b/.test(url);
}

/**
 * 转换‘@id’协议-逆向
 * @param url
 * @returns
 */
export function unwarpId(id: string) {
    return id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length).replace(NULL_BYTE_PLACHOLDER, "\0") : id;
}

/**
 * 转换‘@id’协议
 * @param id
 * @returns
 */
export function warpId(id: string): string {
    return id.startsWith(ID_PREFIX) ? id : ID_PREFIX + id.replace("\0", NULL_BYTE_PLACHOLDER);
}

/**
 * 是否是带有direct特性的url
 * @param url
 * @returns
 */
export function isDirectRequest(url: string): boolean {
    return /(\?|&)direct\b/.test(url);
}

/**
 * @example @joker.front/cli 或者 @joker.front/cli/xxxx/index.js
 */
export const BARE_IMPORT_RE = /^[\w@](?!.*:\/\/)/;

export function isBareImportRequest(id: string): boolean {
    return BARE_IMPORT_RE.test(id);
}

export function resolveFrom(id: string, baseDir: string, preserveSymlinks = false): string {
    return resolve.sync(id, {
        basedir: baseDir,
        paths: [],
        extensions: DEFAULT_EXTENSIONS,
        preserveSymlinks: preserveSymlinks
    });
}

export function nestedResolveFrom(id: string, baseDir: string, preserveSymlinks = false): string {
    let pkgs = id.split(">").map((m) => m.trim());

    try {
        for (let pkg of pkgs) {
            baseDir = resolveFrom(pkg, baseDir, preserveSymlinks);
        }
    } catch {}

    return baseDir;
}

export function isNonDriveRelativeAbsolutePath(p: string): boolean {
    if (isWindows) return /^[A-Za-z]:[/\\]/.test(p);

    return p.startsWith("/");
}

export function toUpperCaseDriveLetter(pathName: string): string {
    return pathName.replace(/^\w:/, (str) => str.toUpperCase());
}

export function prettifyUrl(url: string, root: string): string {
    url = cleanUrl(url);

    let isAbsoluteFile = url.startsWith(root);

    if (isAbsoluteFile) {
        let file = path.relative(root, url);
        let seg = file.split("/");

        let npmIndex = seg.indexOf("node_modules");

        let isSourcemap = file.endsWith(".map");

        if (npmIndex > 0) {
            file = seg[npmIndex + 1];

            if (file.startsWith("@")) {
                file = `${file}/${seg[npmIndex + 2]}`;
            }

            file = `依赖：${color.dim(file)}${isSourcemap ? " (source map)" : ""}`;
        }

        return color.dim(file);
    }

    return color.dim(url);
}

export function isParentDirectory(dir: string, file: string): boolean {
    let splitChar = path.sep;

    if (!dir.endsWith(splitChar)) {
        dir = `${dir}${splitChar}`;
    }
    dir = normalizePath(dir);
    return file.startsWith(dir) || file.toLowerCase().startsWith(dir.toLowerCase());
}

export function fsPathFromId(id: string): string {
    let fsPath = normalizePath(id.startsWith(FS_PREFIX) ? id.slice(FS_PREFIX.length) : id);

    //如果以/或者盘符开始，则直接返回，否则做/
    return fsPath.startsWith("/") || fsPath.match(/^[A-Z]:/i) ? fsPath : `/${fsPath}`;
}

export function fsPathFromUrl(url: string): string {
    return fsPathFromId(cleanUrl(url));
}

export const REQUEST_QUERY_SPLIT_RE = /\?(?!.*[\/|\}])/;
export function parseRequest(id: string): Record<string, string> | undefined {
    let [, search] = id.split(REQUEST_QUERY_SPLIT_RE, 2);

    if (!search) return;

    return Object.fromEntries(new URLSearchParams(search));
}

//#endregion

//#region 系统相关操作类
/**
 * 打开浏览器
 * @param url
 * @returns
 */
export function openBrowser(url: string) {
    let browser = process.env.BROWSER || "";

    if (browser.toLowerCase().endsWith(".js")) {
        let extraArgs = process.argv.slice(2);
        crossSpawn(process.execPath, [browser, ...extraArgs, url], { stdio: "inherit" }).on("close", (code) => {
            if (code !== 0) {
                logger.error("浏览器", "打开浏览器时，运行特殊脚本场景失败，脚本地址为：" + browser);
            }
        });
    } else if (browser.toLowerCase() !== "none") {
        if (process.platform === "darwin" && (browser === "" || browser === "google chrome")) {
            try {
                execSync('ps cax | grep "Google Chrome"');
                execSync('osascript openChrome.applescript "' + encodeURI(url) + '"', {
                    cwd: path.join(CLI_PACKAGE_DIR, "bin"),
                    stdio: "ignore"
                });
                return;
            } catch (e) {
                logger.debug("浏览器", "使用ps cax未启动浏览器，将采用默认方式");
            }
        }

        if (process.platform === "darwin" && browser === "open") {
            browser = "";
        }

        try {
            open(url, browser ? { app: { name: browser } } : {}).catch(() => {});
        } catch (e) {}
    } else {
        logger.error("浏览器", "打开浏览器失败，识别process.env.browser为none");
    }
}
//#endregion

//#region 文件操作类
/**
 * 读取JSON文件
 * @param filePath
 * @returns
 */
export function readJSON(filePath: string): any {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
        logger.debug(LOGTAG, `readJSON方法读取/解析文件失败：${filePath}`);
        return {};
    }
}

/**
 * 返回公共文件路径
 * 所有public文件都会在根目录中提供索引，如果找到，则按照公共资源处理，否则返回空
 * 交由下面程序处理
 * @param publicDir public目录
 * @param url 文件URL
 * @returns
 */
export function getPublicFilePath(publicDir: string | false, url: string): string | undefined {
    if (!publicDir || !url.startsWith("/")) return;

    let filePath = path.join(publicDir, cleanUrl(url));

    if (fs.existsSync(filePath)) {
        return filePath;
    }
}

/**
 * 清空文件夹
 * @param dir 文件夹地址
 * @param skip 需要跳过/排除的文件
 */
export function emptyDir(dir: string, skip?: string[]): void {
    for (let file of fs.readdirSync(dir)) {
        if (skip?.includes(file)) {
            continue;
        }

        fs.rmSync(path.resolve(dir, file), { recursive: true, force: true });
    }
}

/**
 * 复制文件夹
 * @param dir 原文件夹
 * @param aim 目标文件夹
 */
export function copyDir(dir: string, aim: string): void {
    fs.mkdirSync(aim, { recursive: true });

    for (let file of fs.readdirSync(dir)) {
        let srcFile = path.resolve(dir, file);

        if (srcFile === aim) {
            continue;
        }

        let aimFile = path.resolve(aim, file);

        if (fs.statSync(srcFile).isDirectory()) {
            copyDir(srcFile, aimFile);
        } else {
            fs.copyFileSync(srcFile, aimFile);
        }
    }
}

/**
 * 创建/写入一个文件
 * @param filePath 文件地址
 * @param data 文件内容
 */
export function writeFile(filePath: string, data: string) {
    let dir = path.dirname(filePath);

    if (fs.existsSync(dir) === false) {
        fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, data);
}

/**
 * 删除文件夹
 *
 * @returns Promise<void>|void
 */
export const removeDir = isWindows
    ? promisify(gracefulRemoveDir)
    : function (dir: string) {
          fs.rmSync(dir, { recursive: true, force: true });
      };

/**
 * 重命名文件夹
 * @returns Promise<void>|void
 */
export const renameDir = isWindows ? promisify(gracefulRename) : fs.renameSync;

const GRACEFUL_REMOVE_DIR_TIMEOUT = 5000;
const GRACEFUL_RENAME_TIMEOUT = 5000;
function gracefulRemoveDir(dir: string, cb?: (error: NodeJS.ErrnoException | null) => void) {
    let start = Date.now();

    let backoff = 0;

    fs.rm(dir, { recursive: true }, function CB(er) {
        if (er) {
            if (
                (er.code === "ENOTEMPTY" || er.code === "EACCES" || er.code === "EPERM") &&
                Date.now() - start < GRACEFUL_REMOVE_DIR_TIMEOUT
            ) {
                setTimeout(function () {
                    fs.rm(dir, { recursive: true }, CB);
                }, backoff);

                if (backoff < 100) backoff += 10;
                return;
            }

            if (er.code === "ENOENT") {
                er = null;
            }
        }

        cb?.(er);
    });
}

function gracefulRename(from: string, to: string, cb: (error: NodeJS.ErrnoException | null) => void) {
    let start = Date.now();

    let backoff = 0;

    fs.rename(from, to, function CB(er) {
        if (er) {
            if (er && (er.code === "EACCES" || er.code === "EPERM") && Date.now() - start < GRACEFUL_RENAME_TIMEOUT) {
                setTimeout(() => {
                    fs.stat(to, function (stater, st) {
                        if (stater && stater.code === "ENOENT") {
                            fs.rename(from, to, CB);
                        } else {
                            CB(er);
                        }
                    });
                }, backoff);

                if (backoff < 100) backoff += 10;
                return;
            }
        }

        cb?.(er);
    });
}

export function getFileStat(fileName: string): fs.Stats | undefined {
    try {
        return fs.statSync(fileName, { throwIfNoEntry: false });
    } catch {
        return;
    }
}
//#endregion

//#region 值转换

export const LINE_RE = /\r?\n/;

/**
 * offset -> pos
 * @param source
 * @param offset
 * @returns
 */
export function offsetToPosition(
    source: string,
    offset: number | { line: number; column: number }
): { line: number; column: number } {
    if (typeof offset === "number") {
        let lines = source.split(LINE_RE);

        if (offset > source.length) {
            logger.error(LOGTAG, "offsetToPosition:索引超出文档长度");
            return {
                column: 0,
                line: lines.length
            };
        }

        let sum = 0;
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];

            let lineLength = line.length + 1;

            if (sum + lineLength >= offset) {
                return {
                    line: i + 1,
                    column: offset - sum + 1
                };
            }

            sum += lineLength;
        }

        return {
            line: lines.length,
            column: 0
        };
    }

    return offset;
}

/**
 * pos -> offset
 * @param source
 * @param pos
 * @returns
 */
export function positionToOffset(source: string, pos: number | { line: number; column: number }): number {
    if (typeof pos === "number") return pos;

    let lines = source.split(LINE_RE);

    let sum = 0;

    for (let i = 0; i < pos.line - 1; i++) {
        if (lines[i]) {
            sum += lines[i].length + 1;
        }
    }

    return sum + pos.column;
}

/**
 * 输出代码，并对其进行标注，适用于错误、警告位置标注
 * @param source
 * @param start
 * @param end
 * @returns
 */
export function generateCodeFrame(source: string, start: number | { line: number; column: number }, end?: number) {
    let startOffset = positionToOffset(source, start);
    let endOffset = end || startOffset;

    let lines = source.split(LINE_RE);

    let count = 0;
    let result: string[] = [];
    let range = 2;
    for (let i = 0; i < lines.length; i++) {
        if (count >= startOffset) {
            for (let j = i - range; j <= i + range || endOffset > count; j++) {
                if (j < 0 || j >= lines.length) continue;

                let lineIndex = j + 1;

                result.push(
                    `${lineIndex}${" ".repeat(Math.max(3 - String(lineIndex).length, 0))}|  ${lines[lineIndex]}`
                );

                let lineLength = lines[j].length;

                if (j === i) {
                    let pad = Math.max(startOffset - (count - lineLength) + 1, 0);
                    let length = Math.max(1, endOffset > count ? lineLength - pad : endOffset - startOffset);

                    result.push(`   |   ${" ".repeat(pad) + "^".repeat(length)}`);
                } else if (j > i) {
                    if (endOffset > count) {
                        result.push(`   |   ${"^".repeat(Math.max(Math.min(endOffset - count, lineLength), 1))}`);
                    }

                    count += lineLength + 1;
                }
            }

            break;
        }
    }

    return result.join("\n");
}

/**
 * 通过rolluperror创建带颜色标注的错误提示
 * @param err
 * @param args
 * @param stack
 */
export function createErrorMsgFromRollupError(err: RollupError) {
    let result: string[] = [color.yellow(`信息：${err.message}`)];
    if (err.plugin) {
        result.push(` Plugin:${color.magenta(err.plugin)}`);
    }

    if (err.id) {
        result.push(` id:${color.cyan(err.id)}`);
    }

    if (err.frame) {
        result.push(color.yellow(tabLineContent(err.frame)));
    }

    if (err.stack) {
        result.push(tabLineContent(clearnStack(err.stack)));
    }

    return result.join("\n");
}

export function tabLineContent(content: string, tab: number = 2): string {
    let lines = content.split(LINE_RE);

    return lines.map((m) => ` `.repeat(tab) + m).join("\n");
}

export function clearnStack(stack: string): string {
    return stack
        .split(/\n/g)
        .filter((m) => /^\s*at/.test(m))
        .join("\n");
}

export const NULL_SOURCE_MAP: RawSourceMap = {
    names: [],
    sources: [],
    mappings: "",
    version: 3,
    ignoreList: undefined
};

export function escapeToLinuxLikePath(path: string): string {
    if (/^[A-Z]:/.test(path)) {
        return path.replace(/^([A-Z]):\//, "/windows/$1/");
    }
    if (/^\/[^/]/.test(path)) {
        return `/linux${path}`;
    }
    return path;
}

export function unescapeToLinuxLikePath(path: string): string {
    if (path.startsWith("/linux/")) {
        return path.slice("/linux".length);
    }

    if (path.startsWith("/windows/")) {
        return path.replace(/^\/windows\/([A-Z])\//, "$1:/");
    }

    return path;
}

export function combineSourceMaps(
    fileName: string,
    sourceMapList: Array<DecodedSourceMap | RawSourceMap>,
    excludeContent: boolean = true
): any {
    if (sourceMapList.length === 0 || sourceMapList.every((m) => m.sources.length === 0)) {
        return { ignoreList: undefined, ...NULL_SOURCE_MAP };
    }

    sourceMapList = sourceMapList.map((item) => {
        let nItem = { ...item };

        nItem.sources = item.sources.map((source) => (source ? escapeToLinuxLikePath(source) : null));

        if (item.sourceRoot) {
            nItem.sourceRoot = escapeToLinuxLikePath(item.sourceRoot);
        }
        return nItem;
    });

    let escapedFileName = escapeToLinuxLikePath(fileName);

    let useArray = sourceMapList.slice(0, -1).find((m) => m.sources.length !== 1) === undefined;
    let map: SourceMap;
    if (useArray) {
        map = remapping(sourceMapList, () => null, excludeContent);
    } else {
        let mapIndex = 1;

        map = remapping(
            sourceMapList[0],
            function loader(sourcefile) {
                if (sourcefile === escapedFileName && sourceMapList[mapIndex]) {
                    return sourceMapList[mapIndex++];
                }
                return null;
            },
            excludeContent
        );
    }

    map.sources = map.sources.map((source) => (source ? unescapeToLinuxLikePath(source) : source));

    map.file = fileName;

    return map;
}

/**
 * 查找文件
 * @param dir 目录
 * @param fileName 文件名称
 * @param rtPath 是否返回地址，false则返回文件内容'utf-8'
 * @returns  针对fileName传递数组时，只要找到一个即返回内容
 */
export function lookupFile(dir: string, fileName: string | string[], rtPath: boolean = false): string | undefined {
    let files = [fileName].flat();
    for (let file of files) {
        let fullPath = path.resolve(dir, file);

        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
            return rtPath ? fullPath : fs.readFileSync(fullPath, "utf-8");
        }
    }

    let parentDir = path.dirname(dir);

    if (parentDir !== dir) {
        return lookupFile(parentDir, fileName, rtPath);
    }
}

/**
 * 获取buffer/string 的hash值
 * @param text 值
 * @param max hash最大长度，默认8
 * @returns
 */
export function getHash(text: Buffer | string, max: number = 8): string {
    return createHash("sha256")
        .update(typeof text === "string" ? text : new Uint8Array(text))
        .digest("hex")
        .substring(0, max);
}

/**
 * 创建一个可操作的Promise
 */
export function createOperablePromise(): {
    promise: Promise<void>;
    resolve: () => void;
} {
    let _resolve: () => void;

    let promise = new Promise<void>((resolve) => {
        _resolve = resolve;
    });

    return { promise, resolve: _resolve! };
}

/**
 * 将id/path进行打平
 * @param id
 */
export function flattenId(id: string): string {
    return cleanUrl(id)
        .replace(/[\/:]/g, "_")
        .replace(/[\.]/g, "__")
        .replace(/(\s*>\*)/g, "___");
}

/**
 * 摘取部分Object内容
 * @param obj
 * @param key
 * @returns
 */
export function getPartObject<T>(obj: Record<string, T>, key: keyof T): Record<string, any> {
    let result: Record<string, any> = {};

    for (let name in obj) {
        if (name === key) {
            result[name] = obj[name];
        }
    }

    return result;
}

export interface ControlPromise {
    promise: Promise<void>;
    resolve: () => void;
}

/**
 * 返回一个可控制的promise，用于主动控制异步状态
 * @returns
 */
export function createControlPromise(): ControlPromise {
    let resolve: () => void;

    let promise = new Promise<void>((_resolve) => {
        resolve = _resolve;
    });

    return { promise, resolve: resolve! };
}

/**
 * 判断当前id是否包含在list中
 * @param list
 * @param id
 * @returns
 */
export function moduleListContains(list: string[] | undefined, id: string): boolean | undefined {
    return list?.some((m) => m === id || id.startsWith(m + "/"));
}

/**
 * 去除内容中 UTF-8 BOM
 * @param content
 * @returns
 */
export function stripBomTag(content: string): string {
    if (content.charCodeAt(0) === 0xfeff) {
        return content.slice(1);
    }

    return content;
}

export function transformStableResult(s: MagicString, id: string, config: ResolvedConfig): TransformResult {
    return {
        code: s.toString(),
        map: config.command === "build" && config.build.sourcemap ? s.generateMap({ hires: true, source: id }) : null
    };
}

function ansiRegex({ onlyFirst = false } = {}) {
    const pattern = [
        "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)",
        "(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))"
    ].join("|");

    return new RegExp(pattern, onlyFirst ? undefined : "g");
}

export function strip(str: string) {
    return str.replace(ansiRegex(), "");
}

/**
 * 异步替换
 * @param input
 * @param re
 * @param replacer
 * @returns
 */
export async function asyncReplace(
    input: string,
    re: RegExp,
    replacer: (match: RegExpExecArray) => string | Promise<string>
): Promise<string> {
    let match: RegExpExecArray | null;
    let remaining = input;
    let rewritten = "";

    while ((match = re.exec(remaining))) {
        rewritten += remaining.slice(0, match.index);
        rewritten += await replacer(match);
        remaining = remaining.slice(match.index + match[0].length);
    }

    rewritten += remaining;
    return rewritten;
}

/**
 * 在内容中追加SourceMap
 * @param type
 * @param code
 * @param map
 * @returns
 */
export function getCodeWithSourcemap(type: "js" | "css", code: string, map: RollupSourceMap | undefined): string {
    if (type === "js") {
        return (code += `\n//# sourceMappingURL=${getSourceMapUrl(map)}`);
    }

    return (code += `\n/*# sourceMappingURL=${getSourceMapUrl(map)} */`);
}

export function getSourceMapUrl(map?: RollupSourceMap | string): string {
    if (typeof map !== "string") {
        map = JSON.stringify(map);
    }

    return `data:application/json;base64,${Buffer.from(map).toString("base64")}`;
}

export const COMMENT_RE = /<!--.*?-->/gs;
export const MULTI_LINE_COMMENT_RE = /\/\*(.|[\r\n])*?\*\//gm;
export const SINGLE_LINE_COMMENT_RE = /\/\/.*/g;

export function clearCssComments(raw: string): string {
    return raw.replace(MULTI_LINE_COMMENT_RE, (s) => " ".repeat(s.length));
}
//#endregion

//#region 请求/加载处理
export type FilterPattern = ReadonlyArray<string | RegExp> | string | RegExp | null;
export const createFilter = _createFilter as (
    include?: FilterPattern,
    exclude?: FilterPattern,
    options?: { resolve?: string | false | null }
) => (id: string | unknown) => boolean;
//#endregion

export function evalValue<T = any>(rawValue: string): T {
    const fn = new Function(`
      var console, exports, global, module, process, require
      return (\n${rawValue}\n)
    `);
    return fn();
}
