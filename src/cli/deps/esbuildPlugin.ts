import { ImportKind, Plugin } from "esbuild";
import { ExportDatas } from "./metadata";
import { ASSET_TYPES, FILE_SUFFIX, ResolvedConfig } from "../config";
import { CSS_LANG_ARRAY, flattenId, moduleListContains, normalizePath } from "../utils";
import path from "node:path";
import { isEmptyStr, isExternalUrl } from "@joker.front/shared";
import { browserExternalId } from "../plugins/resolve";

/**
 * 针对外部引用转换cjs模式的esbuild插件
 * @param externals
 */
export function esbuildCjsExternalPlugin(externals: string[]): Plugin {
    return {
        name: "cjs-external",
        setup(build) {
            build.onResolve({ filter: /.*/, namespace: "external" }, (args) => ({
                path: args.path,
                external: true
            }));

            let externalFilter = new RegExp(
                externals
                    .map((m) => {
                        return `^${m.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&")}$`;
                    })
                    .join("|")
            );

            build.onResolve({ filter: externalFilter }, (args) => ({
                path: args.path,
                namespace: "external"
            }));

            build.onLoad({ filter: /.*/, namespace: "external" }, (args) => ({
                contents: `export * from ${JSON.stringify(args.path)}`
            }));
        }
    };
}

const EXTERNAL_WITH_CONVERSION_NAMESPACE = "joker:dep-pre-bundle:external-conversion";
const CONVERTED_EXTERNAL_PREFIX = "joker-dep-pre-bundle-external:";

export function esbuildDepPlugin(
    flatIdDeps: Record<string, string>,
    flatIdToExports: Record<string, ExportDatas>,
    externals: string[],
    config: ResolvedConfig
): Plugin {
    let _resolve = config.createResolver({
        asSrc: false,
        scan: true
    });

    let _resolveRequire = config.createResolver({
        asSrc: false,
        scan: true,
        isRequire: true
    });

    function resolve(id: string, importer: string, kind: ImportKind, resolveDir?: string): Promise<string | undefined> {
        let _importer: string;

        if (resolveDir) {
            _importer = normalizePath(path.join(resolveDir, "*"));
        } else {
            _importer = importer in flatIdDeps ? flatIdDeps[importer] : importer;
        }

        return (kind.startsWith("require") ? _resolveRequire : _resolve)(id, _importer);
    }

    //判断时否是入口/引用实体，将按照dep返回，并对id进行转换
    function resolveEntry(id: string) {
        let flatId = flattenId(id);

        if (flatId in flatIdDeps) {
            return { path: flatId, namespace: "dep" };
        }
    }

    let EXTERNALTYPES = [...CSS_LANG_ARRAY, FILE_SUFFIX].concat(ASSET_TYPES);

    return {
        name: "joker:dep-pre-bundle",
        setup(build) {
            build.onResolve(
                { filter: new RegExp(`\\.(${EXTERNALTYPES.join("|")})(\\?.*)?$`) },
                async ({ path: id, importer, kind }) => {
                    if (id.startsWith(CONVERTED_EXTERNAL_PREFIX)) {
                        return {
                            path: id.slice(CONVERTED_EXTERNAL_PREFIX.length),
                            external: true
                        };
                    }

                    let resolved = await resolve(id, importer, kind);

                    if (resolved) {
                        if (kind === "require-call") {
                            return {
                                path: resolved,
                                namespace: EXTERNAL_WITH_CONVERSION_NAMESPACE
                            };
                        }

                        return {
                            path: resolved,
                            external: true
                        };
                    }
                }
            );

            build.onLoad({ filter: /./, namespace: EXTERNAL_WITH_CONVERSION_NAMESPACE }, (args) => {
                return {
                    loader: "js",
                    contents:
                        `export { default } from ${CONVERTED_EXTERNAL_PREFIX}${args.path};` +
                        `export * from ${CONVERTED_EXTERNAL_PREFIX}${args.path};`
                };
            });

            build.onResolve({ filter: /^[\w@][^:]/ }, async ({ path: id, importer, kind }) => {
                //外部
                if (moduleListContains(externals, id)) {
                    return {
                        path: id,
                        external: true
                    };
                }

                if (isEmptyStr(importer)) {
                    let entry = resolveEntry(id);
                    if (entry) return entry;
                }

                let resolved = await resolve(id, importer, kind);

                if (resolved) {
                    if (resolved.startsWith(browserExternalId)) {
                        return {
                            path: id,
                            namespace: "browser-external"
                        };
                    }

                    if (isExternalUrl(resolved)) {
                        return {
                            path: resolved,
                            external: true
                        };
                    }

                    return {
                        path: path.resolve(resolved)
                    };
                }
            });

            build.onLoad({ filter: /.*/, namespace: "dep" }, ({ path: id }) => {
                let entryFile = flatIdDeps[id];
                let root = path.resolve(config.root);
                let relativePath = normalizePath(path.relative(root, entryFile));

                if (
                    relativePath.startsWith("./") === false &&
                    relativePath.startsWith("../") === false &&
                    relativePath !== "."
                ) {
                    relativePath = "./" + relativePath;
                }

                let contents = "";

                let exportsData = flatIdToExports[id];

                //没有输入输出
                if (!exportsData.hasImport && !exportsData.exports.length) {
                    contents += `export default require(${JSON.stringify(relativePath)});`;
                } else {
                    if (exportsData.exports.includes("default")) {
                        contents += `import d from ${JSON.stringify(relativePath)};export default d;`;
                    }

                    if (
                        exportsData.hasTransferExports ||
                        exportsData.exports.length > 1 ||
                        exportsData.exports[0] !== "default"
                    ) {
                        contents += `\nexport * from ${JSON.stringify(relativePath)}`;
                    }
                }

                return {
                    loader: "js",
                    contents,
                    resolveDir: root
                };
            });

            build.onLoad({ filter: /.*/, namespace: "browser-external" }, ({ path: id }) => {
                return {
                    contents: `\
module.exports = Object.create(
    new Proxy(
        {},
        {
            get(_, key) {
                if (
                    key !== "__esModule" &&
                    key !== "__proto__" &&
                    key !== "constructor" &&
                    key !== "splice"
                    ) {
                        throw new Error(
                            "模块：" + ${id} + " 不允许访问其" + (key || "").toString() + "属性"
                        );
                    }
                 }
            }
        )
    );`
                };
            });
        }
    };
}
