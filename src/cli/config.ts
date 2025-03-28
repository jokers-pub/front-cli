import fs, { readFileSync } from "node:fs";
import path from "node:path";
import { logger } from "./logger";
import { resolveServerOpt, ServerOptions } from "./server";
import { CLI_PACKAGE_DIR, getHash, lookupFile, normalizePath } from "./utils";
import { Plugin, sortPlugins } from "./plugin";
import { BuildOptions, resolveBuildOpt } from "./build";
import { integrationPlugins } from "./plugins";
import { InternalResolveOptions, ResolveFn, ResolveOptions, resolvePlugin } from "./plugins/resolve";
import { PluginContainer } from "./server/pluginContainer";
import { DepHandler } from "./deps";
import { PackageCache } from "./package";
import { CSSOptions } from "./plugins/css";

export const DEFAULT_SERVER_PORT = 5858;
export const DEFAULT_WS_PORT = 25679;

const LOGTAG = "配置文件";

export const FILE_SUFFIX = "joker";

//#region 地址前缀
export const ID_PREFIX = "/@id/";
export const FS_PREFIX = "/@fs/";
export const NULL_BYTE_PLACHOLDER = `__J00J__`;
export const CLIENT_PLUBLIC_PATH = "/@joker.front/client";

export const INTERNAL_REQUEST = [ID_PREFIX, CLIENT_PLUBLIC_PATH];

export const CLIENT_ENTRY = path.resolve(CLI_PACKAGE_DIR, "dist/client.es.js");
export const CLIENT_DIR = path.dirname(CLIENT_ENTRY);
//#endregion
const packagePath = path.join(__dirname, "../package.json");

export const { version } = JSON.parse(readFileSync(packagePath).toString());

export const ESBUILD_MODULES_TARGET = ["es2020", "edge88", "firefox78", "chrome87", "safari13"];
export const DEFAULT_EXTENSIONS = [".js", "mjs", "mts", ".ts", ".json"];
export const DEFAULT_MAIN_FIELDS = ["browser", "module", "jsnext:main", "jsnext"];

export interface Config {
    /**
     * 项目文根
     * @default process.cwd()
     */
    root?: string;
    /**
     * 输出运行时公共文根
     * @default '/'
     */
    base?: string;

    /**
     * 运行模式
     * server服务一定是起服务，不做构建
     * build 只做构建，一定不做服务代理
     * @default 'server'
     */
    command?: "server" | "build";

    /**
     * 对应process.env.NODE_ENV
     * @default 'development'
     */
    mode?: string;

    /**
     * 开发模式下的Server配置
     */
    server?: ServerOptions;
    /**
     * 构建配置（Server+Build模式下文件构建配置）
     */
    build?: BuildOptions;
    /**
     * 定义缓存目录，存放dep依赖缓存等文件
     * 默认为package.json所在文件夹下的node_modules/.joker
     *
     * @default 'node_modules/.joker'
     */
    cacheDir?: string;
    /**
     * 默认文件夹，可以配置static静态文件、公共脚本、公共资源等路径文件夹
     * 此文件内的资源不会被转换编译，仅在build时复制到dist目录下
     * 配置成false代表不启用public
     *
     * @default 'public'
     */
    publicDir?: string | false;
    /**
     * 日志输出等级
     * @default 'info'
     */
    logLeve?: logger.leve;
    /**
     * 是否采用esbuild
     * @default 'true'
     */
    esbuild?: boolean;
    /**
     * 需要额外处理的资源，默认已经支持大部分资源格式
     */
    assetsInclude?: string[];
    /**
     * 插件
     */
    plugins?: Plugin[] | Array<Plugin[]>;

    /**
     * 配置解析器
     */
    resolve?: ResolveOptions;

    /**
     * 全局定义，在开发侧通过import.meta.define.xxx进行使用
     */
    define?: Record<string, any>;

    /**
     * CSS配置
     */
    css?: CSSOptions;
}

export interface ResolvedConfig extends Required<Omit<Config, "plugins">> {
    createResolver: (option: Partial<InternalResolveOptions>) => ResolveFn;
    /**
     * 引用管理
     */
    depHandler: DepHandler;

    /**
     * package.json 解析缓存
     */
    packageCache: PackageCache;

    build: Required<BuildOptions>;

    configPath?: string;
    /**
     * packageJson 文件地址
     */
    pkgPath?: string;

    plugins: Plugin[];
}

export async function resolveCliConfig(
    cliConfig: Config,
    command: Config["command"],
    configPath?: string | false
): Promise<ResolvedConfig> {
    let cwdPath = process.cwd();
    let result: Partial<ResolvedConfig> = {};

    if (configPath !== false) {
        //joker.config.js 文件和vscode的项目配置文件采用同源
        //也可以采用不同源，采用自定义文件地址（可区分环境等）
        let resolvePath = path.resolve(cwdPath, configPath || "joker.config.js");

        if (fs.existsSync(resolvePath)) {
            let fileContent = require(resolvePath);

            if (typeof fileContent === "function") {
                Object.assign(result, fileContent(cliConfig.command) as Config);
            } else {
                Object.assign(result, fileContent);
            }

            result.configPath = resolvePath;

            logger.debug(LOGTAG, `发现配置文件:${resolvePath}`);
        }
    }
    for (let name in cliConfig) {
        let value = (<any>cliConfig)[name];
        if (name === "server" || name === "build") {
            value = value || {};

            for (let key in value) {
                (<any>result[name]) ??= {};

                if (value[key]) {
                    (<any>result[name])[key] = value[key];
                }
            }
        } else {
            if (value) {
                (<any>result)[name] = value;
            }
        }
    }

    result.esbuild ??= true;

    result.logLeve ??= "info";

    result.define ??= {};

    logger.logLeve = result.logLeve;

    result.base ??= "/";

    result.command = command;

    result.css ??= {};

    result.root = result.root ? path.resolve(normalizePath(result.root)) : process.cwd();

    logger.debug(LOGTAG, `root:${result.root}`);

    resolveServerOpt(result);

    resolveBuildOpt(result);

    result.resolve ??= {};

    result.mode ??= "development";

    result.packageCache = new Map();

    if (result.publicDir !== false) {
        result.publicDir = path.resolve(result.root, result.publicDir || "public");
    }
    result.assetsInclude = [...ASSET_TYPES, ...(result.assetsInclude || [])];

    let pkgPath = lookupFile(result.root, "package.json", true);

    if (pkgPath === undefined) {
        logger.warn(LOGTAG, "未在root目录及上级目录中找到package.json，存在异常风险，部分功能按降级方案处理");
    }

    result.pkgPath = pkgPath;

    result.cacheDir = result.cacheDir
        ? path.resolve(result.root, result.cacheDir)
        : pkgPath
        ? path.join(path.dirname(pkgPath), "node_modules/.joker")
        : path.join(result.root, ".joker");

    let sortPluginResult = sortPlugins(result.plugins?.flat() || []);

    result.plugins = await integrationPlugins(result as ResolvedConfig, sortPluginResult);

    //借用plugin容器，创建基于roolup的 resolve能力
    result.createResolver = (option) => {
        let resolverContainer: PluginContainer | undefined = undefined;

        return async (id, importer) => {
            let container =
                resolverContainer ||
                (resolverContainer = await new PluginContainer({
                    ...result,
                    plugins: [
                        resolvePlugin(
                            {
                                ...result.resolve,
                                asSrc: true,
                                preferRelative: false,
                                tryIndex: true,

                                ...option
                            },
                            result as ResolvedConfig
                        )
                    ]
                } as ResolvedConfig));

            return (
                await container.resolveId(id, importer, {
                    scan: option.scan
                })
            )?.id;
        };
    };

    //由于dep 关系是具有缓存优化的，而缓存是依赖于config的hash，所以直接挂载到config中
    result.depHandler = new DepHandler(result as ResolvedConfig);

    logger.debug(LOGTAG, "开始执行自定义插件的config转换周期");

    for (let plugin of result.plugins) {
        if (plugin.configTransform) {
            await plugin.configTransform(result as ResolvedConfig);
        }
    }

    logger.debug(LOGTAG, "完成配置文件整合");

    return result as ResolvedConfig;
}

export function getConfigHash(config: ResolvedConfig) {
    //优先级 从左到右
    let keyFiles = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "package.json"];

    let content = lookupFile(config.root, keyFiles) || "";

    let transformConfig: any = { ...config };
    //只保留插件名称
    transformConfig.plugins = config.plugins?.flat().map((m) => m.name);

    //删除动态值，防止污染hash一致性
    delete transformConfig.depHandler;

    content += JSON.stringify(transformConfig, (key, value) => {
        if (typeof value === "function" || value instanceof RegExp) {
            return value.toString();
        }
        return value;
    });

    return getHash(content);
}

export const ASSET_TYPES: string[] = [
    // images
    "png",
    "jpe?g",
    "jfif",
    "pjpeg",
    "pjp",
    "gif",
    "svg",
    "ico",
    "webp",
    "avif",

    // media
    "mp4",
    "webm",
    "ogg",
    "mp3",
    "wav",
    "flac",
    "aac",

    // fonts
    "woff2?",
    "eot",
    "ttf",
    "otf",

    // other
    "webmanifest",
    "pdf",
    "txt"
];

export function getClinetImport(config: ResolvedConfig): string {
    return path.posix.join(config.base, CLIENT_PLUBLIC_PATH);
}
