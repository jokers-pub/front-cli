import path from "node:path";
import fs from "node:fs";
import type { CustomPluginOptions, PartialResolvedId } from "rollup";
import { CLIENT_ENTRY, DEFAULT_EXTENSIONS, DEFAULT_MAIN_FIELDS, FS_PREFIX, ResolvedConfig } from "../config";
import { Plugin } from "../plugin";
import {
    addUrlQuery,
    DEP_VERSION_RE,
    ensureVolumeInPath,
    fsPathFromId,
    getFileStat,
    getPossibleTsSrcPath,
    isBareImportRequest,
    isNonDriveRelativeAbsolutePath,
    isPossibleTsOutput,
    isTSRequest,
    isWindows,
    nestedResolveFrom,
    NODE_MODULES_RE,
    normalizePath,
    OPTIMIZABLE_ENTRY_RE,
    resolveFrom,
    slash,
    SPECIAL_QUERT_RE
} from "../utils";
import { findNearestPackageData, loadPackageData, PackageData, resolvePackageData } from "../package";
import { logger } from "../logger";
import { cleanUrl, isDataUrl, isExternalUrl, isObject } from "@joker.front/shared";
import { DepHandler } from "../deps";
import { exports as _resolveExports } from "resolve.exports";
import { hasESMSyntax } from "mlly";
import { isWorkerRequest } from "./worker";

const LOGTAG = "plugin/resolve";

/** 为browser：false脚本做兜底 */
export const browserExternalId = "__joker-browser-external__";

export interface ResolveOptions {
    /**
     * 主入口字段，做兜底
     * @default ['browser','module', 'jsnext:main', 'jsnext']
     */
    mainFields?: string[];
    //后缀扩展
    extensions?: string[];
}

export interface InternalResolveOptions extends ResolveOptions {
    isRequire?: boolean;

    /**
     * 保持系统路径
     */
    preserveSymlinks?: boolean;

    /**
     * 是否是需要解析url
     */
    asSrc?: boolean;

    //是tsimport
    isFromTsImport?: boolean;

    //是否尝试首页index
    tryIndex?: boolean;

    //尝试前缀修复
    tryPrefix?: string;

    //忽略package.json 的入口指向
    skipPackageJson?: boolean;

    //优先相对路径
    preferRelative?: boolean;

    //启动扫描
    scan?: boolean;
}

export type ResolveFn = (id: string, importer?: string) => Promise<string | undefined>;

export function resolvePlugin(option: InternalResolveOptions, config: ResolvedConfig): Plugin {
    return {
        name: "joker:resolve",
        async resolveId(
            id: string,
            importer: string | undefined,
            resolveOpts: { custom?: CustomPluginOptions | undefined; isEntry: boolean; scan?: boolean | undefined }
        ) {
            //过滤掉内置id
            if (id[0] === "\0") return;

            if (id.startsWith(browserExternalId)) {
                return id;
            }

            //排除commonjs库 可能来自@rollup/commonjs
            if (/\?commonjs/.test(id) || id === "commonjsHelpers.js") {
                return id;
            }

            //@rollup/commonjs
            let isRequire: boolean = resolveOpts.custom?.["node-resolve"]?.isRequire ?? false;

            let internalResolveOptions: InternalResolveOptions & ResolvedConfig = {
                isRequire,
                ...option,
                ...config,
                scan: resolveOpts.scan ?? option.scan,
                mainFields: option.mainFields ?? DEFAULT_MAIN_FIELDS,
                extensions: option.extensions ?? DEFAULT_EXTENSIONS
            };

            if (importer) {
                if (isWorkerRequest(importer)) {
                    importer = splitFileAndPostfix(importer).file;
                }

                importer = cleanUrl(importer);
                //depScan 由scan.ts中esbuild.onResolve /.*/做了标记
                if (isTSRequest(importer) || resolveOpts.custom?.depScan?.loader?.startsWith("ts")) {
                    internalResolveOptions.isFromTsImport = true;
                } else {
                    let moduleLang = this.getModuleInfo(importer)?.meta?.joker?.lang;

                    internalResolveOptions.isFromTsImport = moduleLang && isTSRequest(`.${moduleLang}`);
                }
            }

            let res: string | PartialResolvedId | undefined;

            if (option.asSrc && config.depHandler.isResolvedDepUrl(id)) {
                return id.startsWith(FS_PREFIX)
                    ? fsPathFromId(id)
                    : normalizePath(ensureVolumeInPath(path.resolve(config.root, id.slice(1))));
            }

            //@fs
            if (option.asSrc && id.startsWith(FS_PREFIX)) {
                let fsPath = fsPathFromId(id);

                res = tryFsResolve(fsPath, internalResolveOptions);

                return ensureVersionQuery(id, res || fsPath, internalResolveOptions);
            }

            //  /foo->/root/foo
            if (option.asSrc && id.startsWith("/")) {
                let fsPath = path.resolve(config.root, id.slice(1));

                if ((res = tryFsResolve(fsPath, internalResolveOptions))) {
                    return ensureVersionQuery(id, res, internalResolveOptions);
                }
            }

            /**
             * 相对路径 ｜｜
             * （优先相对路径 或者 是html）&& id已字符开头
             */
            if (id.startsWith(".") || ((option.preferRelative || importer?.endsWith(".html")) && /^\w/.test(id))) {
                let baseDir = importer ? path.dirname(importer) : process.cwd();

                let fsPath = path.resolve(baseDir, id);

                let normalizeFsPath = normalizePath(fsPath);

                //如果是已被解析缓存的引用
                if (config.depHandler.isResolvedDepFile(normalizeFsPath)) {
                    let browserHash = config.depHandler.getDepInfoFromFile(normalizeFsPath)?.browserHash;

                    if (browserHash) {
                        return addUrlQuery(normalizeFsPath, `v=${browserHash}`);
                    }
                    return normalizeFsPath;
                }

                //browser
                if ((res = tryResolveBrowserMapping(fsPath, importer, internalResolveOptions, true))) {
                    return res;
                }

                let pathFromBaseDir = normalizeFsPath.slice(baseDir.length);

                if (pathFromBaseDir.startsWith("/node_modules")) {
                    logger.warn(
                        LOGTAG,
                        `${normalizeFsPath}: Directly referencing any resources inside node_modules is not recommended. Please use the package import pattern instead.`
                    );

                    let bareImport = pathFromBaseDir.slice("/node_modules/".length);

                    if (
                        (res = tryNodeResolve(bareImport, importer, internalResolveOptions, config.depHandler)) &&
                        res.id.startsWith(normalizeFsPath)
                    ) {
                        return res;
                    }
                }

                if ((res = tryFsResolve(fsPath, internalResolveOptions))) {
                    res = ensureVersionQuery(id, res, internalResolveOptions);

                    let pkg = importer && ID_TO_PKG_MAP.get(importer);

                    if (pkg) {
                        ID_TO_PKG_MAP.set(res, pkg);
                    }
                    return res;
                }
            }

            //在windows中的绝对路径
            if (isWindows && id.startsWith("/")) {
                let baseDir = importer ? path.dirname(importer) : process.cwd();

                let fsPath = path.resolve(baseDir, id);

                if ((res = tryFsResolve(fsPath, internalResolveOptions))) {
                    return ensureVersionQuery(id, res, internalResolveOptions);
                }
            }

            //带盘符 或指向机器文根的 绝对路径
            if (isNonDriveRelativeAbsolutePath(id) && (res = tryFsResolve(id, internalResolveOptions))) {
                return ensureVersionQuery(id, res, internalResolveOptions);
            }

            if (isExternalUrl(id)) {
                return { id, external: true };
            }

            //dataUrl
            if (isDataUrl(id)) {
                return null;
            }

            //e.g. : @joker.front/cli || @joker.front/cli/xxx/index.js
            if (isBareImportRequest(id)) {
                if (
                    option.asSrc &&
                    !internalResolveOptions.scan &&
                    (res = await tryResolveDep(config.depHandler, id, importer))
                ) {
                    return res;
                }

                if ((res = tryResolveBrowserMapping(id, importer, internalResolveOptions, false, false))) {
                    return res;
                }

                if ((res = tryNodeResolve(id, importer, internalResolveOptions, config.depHandler))) {
                    return res;
                }
            }
        },
        load(id) {
            if (id.startsWith(browserExternalId)) {
                if (config.command === "build") {
                    return `export default {}`;
                } else {
                    return `\
      export default new Proxy({}, {
        get(_, key) {
          throw new Error(\`模块已采用browser:false进行了兜底加载，不允许访问内部任何数据\`)
        }
      })`;
                }
            }
        }
    };
}

//通过多次降级方案去解析当前fsName
export function tryFsResolve(filename: string, options: InternalResolveOptions, tryIndex = true): string | undefined {
    let { file, postfix } = splitFileAndPostfix(filename);

    let result: string | undefined;

    //尝试按照原文查询
    if (
        postfix &&
        (result = tryResolveFile(filename, "", options, false, options.tryPrefix, options.skipPackageJson))
    ) {
        return result;
    }

    if ((result = tryResolveFile(file, postfix, options, false, options.tryPrefix, options.skipPackageJson))) {
        return result;
    }

    for (let ext of options.extensions!) {
        if (
            postfix &&
            (result = tryResolveFile(filename + ext, "", options, false, options.tryPrefix, options.skipPackageJson))
        ) {
            return result;
        }
        if (
            (result = tryResolveFile(file + ext, postfix, options, false, options.tryPrefix, options.skipPackageJson))
        ) {
            return result;
        }
    }

    if (
        postfix &&
        (result = tryResolveFile(filename, "", options, tryIndex, options.tryPrefix, options.skipPackageJson))
    ) {
        return result;
    }

    if ((result = tryResolveFile(file, postfix, options, tryIndex, options.tryPrefix, options.skipPackageJson))) {
        return result;
    }
}

function tryResolveFile(
    file: string,
    postfix: string,
    options: InternalResolveOptions,
    tryIndex: boolean,
    tryPrefix?: string,
    skipPackageJson?: boolean
): string | undefined {
    let fileStat = getFileStat(file);

    //无权限｜｜ 无路径
    if (fileStat === undefined) return;

    if (fileStat.isDirectory() === false) {
        let resolved = ensureVolumeInPath(file);

        if (!options.preserveSymlinks) {
            resolved = fs.realpathSync(resolved);
        }

        return normalizePath(resolved) + postfix;
    }

    if (tryIndex) {
        //不跳过package.json 则按照main属性作为入口
        if (!skipPackageJson) {
            try {
                let pkgPath = file + "/package.json";

                //作为文件入口去找，只找当前目录，不向上找，否则可能会出现找错package
                let pkg = loadPackageData(pkgPath, options.preserveSymlinks);
                if (pkg) {
                    let resolved = resolvePackageEntry(file, pkg, options);
                    return resolved;
                }
            } catch (e: any) {
                if (e.code !== "ENOENT" && e.code !== "ENOTDIR") {
                    throw e;
                }
            }
        }

        //否则按照当前目录下index作为入口去解析
        let index = tryFsResolve(file + "/index", options);
        if (index) {
            return index + postfix;
        }
    }

    let tryTsExtension = options.isFromTsImport && isPossibleTsOutput(file);
    //是否是ts import
    if (tryTsExtension) {
        //根据输出文件，推导出可能的源文件地址
        for (let srcPath of getPossibleTsSrcPath(file)) {
            let result = tryResolveFile(srcPath, postfix, options, tryIndex, tryPrefix, skipPackageJson);

            if (result) return result;
        }

        //ts不再尝试前缀
        return;
    }

    if (tryPrefix) {
        let prefixed = `${path.dirname(file)}/${tryPrefix}${path.basename(file)}`;
        return tryResolveFile(prefixed, postfix, options, tryIndex);
    }
}

function tryNodeResolve(
    id: string,
    importer: string | null | undefined,
    options: InternalResolveOptions & ResolvedConfig,
    depHandler: DepHandler
): PartialResolvedId | undefined {
    let { root, command, preserveSymlinks, packageCache } = options;

    /**
     * e.g.
     *
     * 1.  foo>bar>baz  ->   'foo>bar','baz'
     * 2.  foo          ->   '','foo'
     */
    let lastArrowIndex = id.lastIndexOf(">");
    let nestedRoot = id.substring(0, lastArrowIndex).trim();
    let nestedPath = id.substring(lastArrowIndex + 1).trim();

    let possiblePkgIds: string[] = [];

    //循环分割‘/’去寻找可能的pkgPath
    for (let prevSlashIndex = -1; ; ) {
        let slashIndex = nestedPath.indexOf("/", prevSlashIndex + 1);

        //如果找不到则按照结尾位置
        if (slashIndex === -1) {
            slashIndex = nestedPath.length;
        }

        let part = nestedPath.slice(prevSlashIndex + 1, (prevSlashIndex = slashIndex));

        if (!part) break;

        //假设具有扩展名的路径部分不是包根，除了第一个路径部分
        //同时，如果以“@”开头，则跳过第一个路径部分
        if (possiblePkgIds.length ? path.extname(part) : part[0] === "@") {
            continue;
        }

        possiblePkgIds.push(nestedPath.slice(0, slashIndex));
    }

    let baseDir: string;

    if (importer && path.isAbsolute(importer) && fs.existsSync(cleanUrl(importer))) {
        baseDir = path.dirname(importer);
    } else {
        baseDir = root;
    }

    if (nestedRoot) {
        baseDir = nestedResolveFrom(nestedRoot, baseDir, preserveSymlinks);
    }

    let pkg: PackageData | undefined;

    let pkgId = possiblePkgIds.reverse().find((m) => {
        pkg = resolvePackageData(m, baseDir, preserveSymlinks, packageCache);
        return pkg;
    });

    if (pkg === undefined || pkgId === undefined) return;

    let resolveId = resolvePackageEntry;
    let unresolvedId = pkgId;

    //如果pkgPath 不等于 path，则代表有深度引用 e.g. @joker.front/cli/xxx/xxx/sss.css
    let isDeepImport = unresolvedId !== nestedPath;

    if (isDeepImport) {
        resolveId = resolveDeepImport;
        unresolvedId = "." + nestedPath.slice(pkgId.length);
    }

    let resolved: string | undefined;

    resolved = resolveId(unresolvedId, pkg, options);

    if (!resolved) return;

    ID_TO_PKG_MAP.set(resolved, pkg);

    if (resolved.includes("node_modules") === false || options.scan) {
        return {
            id: resolved
        };
    }

    let isScript = OPTIMIZABLE_ENTRY_RE.test(resolved);

    //不是脚本 || 引用方是node_modules内文件 || 是特殊的协议地址
    let skipResolevDep = isScript === false || importer?.includes("node_modules") || SPECIAL_QUERT_RE.test(resolved);

    if (skipResolevDep) {
        if (command === "server") {
            let versionHash = depHandler.depMetadata.browserHash;

            if (versionHash && isScript) {
                resolved = addUrlQuery(resolved, `v=${versionHash}`);
            }
        }
    } else {
        let depInfo = depHandler.registerMissingImport(id, resolved);

        resolved = depHandler.getResolvedDepId(depInfo);
    }

    return { id: resolved };
}

function tryResolveBrowserMapping(
    id: string,
    importer: string | undefined,
    options: InternalResolveOptions & ResolvedConfig,
    isFilePath: boolean,
    externalize?: boolean
) {
    let res: string | undefined;
    let pkg =
        importer &&
        (ID_TO_PKG_MAP.get(importer) || findNearestPackageData(path.dirname(importer), options.packageCache));
    if (pkg && isObject(pkg.data.browser)) {
        let mapId = isFilePath ? "./" + slash(path.relative(pkg.dir, id)) : id;
        let browserMappedPath = mapWithBrowserField(mapId, pkg.data.browser);
        if (browserMappedPath) {
            let fsPath = path.join(pkg.dir, browserMappedPath);
            if (
                (res = isBareImportRequest(browserMappedPath)
                    ? tryNodeResolve(browserMappedPath, importer, options, options.depHandler)?.id
                    : tryFsResolve(fsPath, options))
            ) {
                logger.debug(LOGTAG, `[browser mapped] ${id} -> ${res}`);
                ID_TO_PKG_MAP.set(res, pkg);

                return externalize ? { id: res, external: true } : { id: res };
            }
        } else if (browserMappedPath === false) {
            return browserExternalId;
        }
    }
}

async function tryResolveDep(depHandler: DepHandler, id: string, importer?: string): Promise<string | undefined> {
    await depHandler.scanProcessing;

    let depInfo = depHandler.getDepInfoFromId(id);

    if (depInfo) {
        return depHandler.getResolvedDepId(depInfo);
    }

    if (!importer) return;

    let resolvedSrc: string | undefined;

    try {
        resolvedSrc = normalizePath(resolveFrom(id, path.dirname(importer)));
    } catch {
        return;
    }

    if (resolvedSrc === undefined) return;

    for (let dep of [
        ...Object.values(depHandler.depMetadata.resolved),
        ...Object.values(depHandler.depMetadata.discovered)
    ]) {
        if (dep.id.endsWith(id) === false) continue;

        if (dep.src === resolvedSrc) {
            return depHandler.getResolvedDepId(dep);
        }
    }
}

const ID_TO_PKG_MAP = new Map<string, PackageData>();

/**
 * 解析包入口
 * @param id
 * @param packageData
 * @param options
 * @returns
 */
function resolvePackageEntry(
    id: string,
    packageData: PackageData,
    options: InternalResolveOptions
): string | undefined {
    let cached = packageData.getResolvedCache(".");
    if (cached) return cached;

    //暂不考虑package.json 中的export属性
    let entryPoint: string | undefined | void;

    if (packageData.data.exports) {
        entryPoint = resolveExports(packageData.data, ".", options);
    }

    //优先找browser
    if (!entryPoint || entryPoint.endsWith(".mjs")) {
        let browserEntry =
            typeof packageData.data.browser === "string"
                ? packageData.data.browser
                : isObject(packageData.data.browser) && packageData.data.browser["."];
        if (browserEntry) {
            if (
                !options.isRequire &&
                options.mainFields!.includes("module") &&
                typeof packageData.data.module === "string" &&
                packageData.data.module !== browserEntry
            ) {
                let resolvedBrowserEntry = tryFsResolve(path.join(packageData.dir, browserEntry), options);
                if (resolvedBrowserEntry) {
                    let content = fs.readFileSync(resolvedBrowserEntry, "utf-8");
                    if (hasESMSyntax(content)) {
                        entryPoint = browserEntry;
                    } else {
                        entryPoint = packageData.data.module;
                    }
                }
            } else {
                entryPoint = browserEntry;
            }
        }
    }

    //兜底
    if (!entryPoint) {
        for (const field of options.mainFields!) {
            if (field === "browser") continue; // already checked above
            if (typeof packageData.data[field] === "string") {
                entryPoint = packageData.data[field];
                break;
            }
        }
    }

    entryPoint ||= packageData.data.main;

    let entryPoints = entryPoint ? [entryPoint] : ["index.js", "index.json"];

    for (let entry of entryPoints) {
        if (options.mainFields?.[0] === "sass" && !options.extensions?.includes(path.extname(entry))) {
            entry = "";
            options.skipPackageJson = true;
        }

        //根据entry 从browser中找
        if (isObject(packageData.data.browser)) {
            entry = mapWithBrowserField(entry, packageData.data.browser) || entry;
        }

        let entryPointPath = path.join(packageData.dir, entry);

        let resolvedEntryPoint = tryFsResolve(entryPointPath, options);

        if (resolvedEntryPoint) {
            packageData.setResolvedCache(".", resolvedEntryPoint);
            return resolvedEntryPoint;
        }
    }

    throw new Error(logger.error(LOGTAG, `Failed to resolve package: ${id}. No suitable entry point found.`));
}

function resolveDeepImport(id: string, packageData: PackageData, options: InternalResolveOptions): string | undefined {
    let cache = packageData.getResolvedCache(id);

    if (cache) return cache;

    let relativeId: string | undefined = id;

    let exportsField = packageData.data.exports;
    if (exportsField) {
        if (isObject(exportsField) && Array.isArray(exportsField) === false) {
            let { file, postfix } = splitFileAndPostfix(relativeId);

            let exportsId = resolveExports(packageData.data, file, options);

            if (exportsId !== undefined) {
                relativeId = exportsId + postfix;
            } else {
                relativeId = undefined;
            }
        } else {
            relativeId = undefined;
        }

        if (!relativeId) {
            throw new Error(`The defined ${relativeId} was not found in the "exports" field of package.json.`);
        }
    } else if (isObject(packageData.data.browser)) {
        let { file, postfix } = splitFileAndPostfix(relativeId);
        let mapped = mapWithBrowserField(file, packageData.data.browser);
        if (mapped) {
            relativeId = mapped + postfix;
        }
    }

    if (relativeId) {
        let resolved = tryFsResolve(path.join(packageData.dir, relativeId), options, true);

        if (resolved) {
            packageData.setResolvedCache(id, resolved);
            return resolved;
        }
    }
}

function splitFileAndPostfix(path: string) {
    let file = path;
    //空 || ？|| #
    let postfix = "";

    let postfixIndex = path.indexOf("?");

    if (postfixIndex === -1) {
        postfixIndex = path.indexOf("#");
    }

    if (postfixIndex > 0) {
        file = path.slice(0, postfixIndex);
        postfix = path.slice(postfixIndex);
    }

    return { file, postfix };
}

function ensureVersionQuery(id: string, resolved: string, options: InternalResolveOptions & ResolvedConfig): string {
    let normalizedClientEntry = normalizePath(CLIENT_ENTRY);

    if (options.command !== "build" && !(resolved === normalizedClientEntry)) {
        let isNodeModule = NODE_MODULES_RE.test(normalizePath(id)) || NODE_MODULES_RE.test(normalizePath(resolved));

        //是nodeModule，并且不携带版本
        if (isNodeModule && !resolved.match(DEP_VERSION_RE)) {
            let versionHash = options.depHandler.depMetadata.browserHash;

            if (versionHash && options.depHandler.isOptimizable(resolved)) {
                resolved = addUrlQuery(resolved, `v=${versionHash}`);
            }
        }
    }

    return resolved;
}

function resolveExports(pkg: PackageData["data"], key: string, options: InternalResolveOptions) {
    let conditions: string[] = [];
    if (!options.isRequire) {
        conditions.push("module");
    }

    return _resolveExports(pkg, key, {
        conditions,
        require: options.isRequire,
        browser: true
    })?.[0];
}

function mapWithBrowserField(
    relativePathInPkgDir: string,
    map: Record<string, string | false>
): string | false | undefined {
    let normalizedPath = path.posix.normalize(relativePathInPkgDir);

    for (let key in map) {
        let normalizedKey = path.posix.normalize(key);
        if (
            normalizedPath === normalizedKey ||
            equalWithoutSuffix(normalizedPath, normalizedKey, ".js") ||
            equalWithoutSuffix(normalizedPath, normalizedKey, "/index.js")
        ) {
            return map[key];
        }
    }
}

function equalWithoutSuffix(path: string, key: string, suffix: string) {
    return key.endsWith(suffix) && key.slice(0, -suffix.length) === path;
}
