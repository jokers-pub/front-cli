import { cleanUrl } from "@joker.front/shared";
import { extname } from "node:path";
import type { ModuleInfo, PartialResolvedId } from "rollup";
import { Server } from ".";
import { isCssRequest, isDirectRequest, normalizePath, removeImportQuery, removeTimestampQuery } from "../utils";
import { TransformResult } from "./transformRequest";
import { parse as parserUrl } from "node:url";
import { FS_PREFIX } from "../config";
/**
 * 模块节点类
 *
 * url 和id 的区别在于：
 * url是实际请求的url，id是通过插件进行转换标记后的唯一标志
 * id默认值是url，它可以理解为是url的一个值的变种，比url参数更多，更精准
 * 当然也可以通过插件来更改id指向，可能会指向不通的文件也可能路径不是一个路径
 *
 * filePath 是url的一个无参数的指向，所以他的映射是一对多的关系
 *
 * meta 是对module的标注， 提供插件方做标记和过滤分类用
 */
export class ModuleNode {
    /**
     * id提供扩展用，默认为url，将由插件三方去自由扩展对文件进行特殊化标记
     */
    public id?: string;

    public file?: string;

    public type: "css" | "js";

    public info?: ModuleInfo;

    /**
     * 模块meta标记，供插件做标注
     */
    public meta?: Record<string, any>;

    //以后一次热更时间
    public lastHMRTimer = 0;

    //最后销毁时间
    public lastDisposeTimestamp = 0;

    /**
     * 编译结果
     */
    public transformResult?: TransformResult;

    /** 是否存在import.meta.hot.accept 自我处理程序 */
    public isSelfAccepting?: boolean;

    public importers = new Set<ModuleNode>();

    public importedModules = new Set<ModuleNode>();

    public acceptedHMRDeps = new Set<ModuleNode>();

    public acceptedHMRExports: Set<string> | null = null;

    constructor(public url: string, setDefaultSelfAcceping = true) {
        //css类型 && 非直接页面引用（非直接会有script脚本）
        this.type = isCssRequest(url) && isDirectRequest(url) ? "css" : "js";

        if (setDefaultSelfAcceping) {
            this.isSelfAccepting = false;
        }
    }
}

export class ModuleMap {
    /**
     * URL -> 模块 映射表
     */
    public urlModuleMap = new Map<string, ModuleNode>();

    /**
     * moduleId  -> 模块映射表
     */
    public idModuleMap = new Map<string, ModuleNode>();

    /**
     * 文件 -> 模块映射表 一个文件可能存在多版本多参数，多转换module
     */
    public fileModuleMap = new Map<string, Set<ModuleNode>>();

    public safeModulesPath = new Set<string>();

    constructor(
        private server: Server,
        private resolveIdCallBack: (url: string) => Promise<PartialResolvedId | null>
    ) {}

    /**
     * 根据id查询module
     * @param id
     * @returns
     */
    public getModuleById(id: string): ModuleNode | undefined {
        //id只是一个插件扩展，默认还是url，理论上也是对url做的加工
        return this.idModuleMap.get(removeTimestampQuery(id));
    }

    public async getModuleByUrl(strUrl: string): Promise<ModuleNode | undefined> {
        let { url } = await this.resolveUrl(strUrl);

        return this.urlModuleMap.get(url);
    }

    public getModulesByFile(file: string): Set<ModuleNode> | undefined {
        return this.fileModuleMap.get(file);
    }

    /**
     * 作废一个module，只做销毁标记，清除过程产物，不做数据移除
     * 不移除，留作后续可能会被重新执行
     * @param module
     */
    public disposeModule(module: ModuleNode, isHmr: boolean = false, timestamp?: number) {
        if (isHmr) {
            module.lastHMRTimer = timestamp ?? Date.now();
        } else {
            module.lastDisposeTimestamp = timestamp ?? Date.now();
        }

        module.transformResult = undefined;
    }

    /**
     *  作废所有module结果
     */
    public disposeAllModule() {
        this.idModuleMap.forEach((m) => {
            this.disposeModule(m);
        });
    }

    /**
     * 根据文件销毁相关Module
     * @param file
     */
    public disposeModuleByFile(file: string) {
        let modules = this.getModulesByFile(file);

        modules?.forEach((m) => {
            this.disposeModule(m);
        });
    }

    /**
     * 根据url添加入口模块，存在则返回，没有则创建
     * @param url
     * @returns
     */
    public async addEntryModuleUrl(url: string, setDefaultSelfAcceping = true): Promise<ModuleNode> {
        let urlResolved = await this.resolveUrl(url);

        let module = this.urlModuleMap.get(urlResolved.url);

        if (module) {
            return module;
        }

        module = new ModuleNode(urlResolved.url, setDefaultSelfAcceping);

        if (urlResolved.meta) {
            module.meta = urlResolved.meta;
        }

        this.urlModuleMap.set(urlResolved.url, module);

        module.id = urlResolved.id;

        this.idModuleMap.set(module.id, module);

        module.file = cleanUrl(module.id);

        let fileMaps = this.getModulesByFile(module.file);

        if (fileMaps === undefined) {
            fileMaps = new Set();

            this.fileModuleMap.set(module.file, fileMaps);
        }

        fileMaps.add(module);

        return module;
    }

    public addEntryByFile(file: string): ModuleNode {
        file = normalizePath(file);

        let fileMappedModules = this.fileModuleMap.get(file);

        if (fileMappedModules === undefined) {
            fileMappedModules = new Set();

            this.fileModuleMap.set(file, fileMappedModules);
        }

        let url = `${FS_PREFIX}${file}`;

        for (let module of fileMappedModules) {
            if (module.url === url || module.id === file) {
                return module;
            }
        }

        let result = new ModuleNode(url);

        result.file = file;
        fileMappedModules.add(result);

        return result;
    }

    /**
     * 对URL进行解析转换
     * 1. 去除hmr 时间戳
     * 2. 去除import query
     * 3. 去plugin中转换id以及meta
     * 4. 对url进行合理化转换
     * @param url
     * @returns
     */
    public async resolveUrl(url: string): Promise<{
        url: string;
        id: string;
        meta?: Record<string, any> | null;
    }> {
        url = removeTimestampQuery(url);
        url = removeImportQuery(url);

        let resolved = await this.resolveIdCallBack(url);

        let id = resolved?.id || url;

        if (url !== id && url.includes("\0") === false) {
            let ext = extname(cleanUrl(url));

            let { pathname, search, hash } = parserUrl(url);

            if (ext && pathname!.endsWith(ext) === false) {
                url = pathname + ext + (search || "") + (hash || "");
            }
        }

        return {
            url,
            id,
            meta: resolved?.meta
        };
    }

    /**
     * 更新模块Node
     * @param module
     * @param importedModules
     * @param acceptedModules
     * @param acceptedExports
     * @param isSelfAccepting
     * @returns 返回去除的引用(不再使用的)
     */
    public async updateModuleInfo(
        module: ModuleNode,
        importedModules: Set<string | ModuleNode>,
        acceptedModules: Set<string | ModuleNode>,
        acceptedExports: Set<string> | null,
        isSelfAccepting: boolean
    ): Promise<Set<ModuleNode> | undefined> {
        module.isSelfAccepting = isSelfAccepting;

        let preImports = module.importedModules;
        let nextImports = (module.importedModules = new Set());

        let noLongerImported: Set<ModuleNode> | undefined;

        for (let imported of importedModules) {
            let dep = typeof imported === "string" ? await this.addEntryModuleUrl(imported) : imported;

            dep.importers.add(module);
            nextImports.add(dep);
        }

        preImports.forEach((dep) => {
            if (nextImports.has(dep) === false) {
                dep.importers.delete(module);

                if (dep.importers.size === 0) {
                    noLongerImported ??= new Set();
                    noLongerImported.add(dep);
                }
            }
        });

        let deps = (module.acceptedHMRDeps = new Set());

        for (let accepted of acceptedModules) {
            deps.add(typeof accepted === "string" ? await this.addEntryModuleUrl(accepted) : accepted);
        }

        module.acceptedHMRExports = acceptedExports;

        return noLongerImported;
    }
}
