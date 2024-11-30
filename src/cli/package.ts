import { getFileStat, lookupFile, readJSON, resolveFrom } from "./utils";
import fs from "node:fs";
import path from "node:path";

export interface PackageData {
    fileName: string;

    dir: string;

    webResolvedImports: Record<string, string | undefined>;

    setResolvedCache: (key: string, entry: string) => void;

    getResolvedCache: (key: string) => string | undefined;

    data: {
        [key: string]: any;

        name: string;

        type: string;

        version: string;

        main: string;

        browser: any;

        exports: string | Record<string, any> | string[];

        dependencies: Record<string, string>;
    };
}

export type PackageCache = Map<string, PackageData>;

export function resolvePackageData(
    id: string,
    baseDir: string,
    preserveSymlinks = false,
    packageCache?: PackageCache
): PackageData | undefined {
    let pkg: PackageData | undefined;

    let cacheKey: string = `${id}&${baseDir}&${preserveSymlinks}`;

    if (packageCache) {
        if ((pkg = packageCache.get(id))) {
            return pkg;
        }
    }

    let pkgPath: string | undefined;

    try {
        pkgPath = resolveFrom(`${id}/package.json`, baseDir, preserveSymlinks);
        pkg = loadPackageData(pkgPath, true, packageCache);

        if (packageCache && pkg) {
            packageCache.set(cacheKey, pkg);
        }
        return pkg;
    } catch {}
}

export function loadPackageData(
    pkgPath: string,
    preserveSymlinks?: boolean,
    packageCache?: PackageCache
): PackageData | undefined {
    if (!preserveSymlinks) {
        pkgPath = fs.realpathSync.native(pkgPath);
    }

    let cached: PackageData | undefined;

    if ((cached = packageCache?.get(pkgPath))) {
        return cached;
    }

    let data = readJSON(pkgPath);
    if (!data.name) return undefined;

    let pkDir = path.dirname(pkgPath);

    let result: PackageData = {
        fileName: pkgPath,
        dir: pkDir,
        data,
        webResolvedImports: {},
        setResolvedCache(key: string, entry: string) {
            result.webResolvedImports[key] = entry;
        },
        getResolvedCache(key) {
            return result.webResolvedImports[key];
        }
    };

    packageCache?.set(pkgPath, result);

    return result;
}

export function removePackageData(packageCache: PackageCache, pkgPath: string) {
    packageCache.delete(pkgPath);

    let pkgDir = path.dirname(pkgPath);

    packageCache.forEach((pkg, key) => {
        if (pkg.dir === pkgDir) {
            packageCache.delete(key);
        }
    });
}

export function findNearestPackageData(basedir: string, packageCache?: PackageCache): PackageData | undefined {
    while (basedir) {
        if (packageCache) {
            let cached = packageCache.get(basedir);
            if (cached) return cached;
        }

        const pkgPath = path.join(basedir, "package.json");
        if (getFileStat(pkgPath)?.isFile()) {
            try {
                let pkgData = loadPackageData(pkgPath);

                if (packageCache && pkgData) {
                    packageCache.set(basedir, pkgData);
                }

                return pkgData;
            } catch {}
        }

        const nextBasedir = path.dirname(basedir);
        if (nextBasedir === basedir) break;
        basedir = nextBasedir;
    }
}

/**
 * 查询指定目录中的packageJson，逐级向上查找
 * @param searchRoot
 * @returns
 */
export function getPkgJson(searchRoot: string): PackageData["data"] | undefined {
    let pkgPath = lookupFile(searchRoot, `package.json`, true);
    if (pkgPath) {
        return loadPackageData(pkgPath, true)?.data;
    }
}
