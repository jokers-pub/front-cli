import { SFCDescriptor } from "@joker.front/sfc";
import { ResolvedConfig } from "../../config";
import { transformWithEsbuild } from "../esbuild";
import { JokerParserResult, parserSFCFile } from "./descriptor";

const SFC_SCRIPT_EXPORT_DEFAULT = "_JOKER_SFC_SCRIPT_HANDLER_";
const SFC_TEMPLATE_EXPORT_DEFAULT = "_JOKER_SFC_TEMPLATE_HANDLER_";
const SFC_SCOPED_PROPERTY_NAME = "_JOKER_SCOPE_ID_";
const SFC_MAIN = "_JOKER_MAIN_";
const JOKER_HMR_RUNTIME = "__JOKER_HMR_RUNTIME";

//#region 主文件分流
export function transformJoker(config: ResolvedConfig, code: string, filename: string) {
    let parserResult = parserSFCFile(config, filename, code);

    let hmr = !!(config.command === "server" && config.server.hmr);

    let templateCodePart = trasnformTemplateImport(filename, parserResult, hmr);
    let scriptCodePart = trasnformScriptImport(filename, parserResult, hmr);
    let styleCodePart = trasnformStyleImport(filename, parserResult.descriptor, parserResult.hash);

    let output = [
        config.command === "server" ? 'window[Symbol.for("__JOKER_TRACE_EXPRESSIONS__")]??=true;' : "",
        //HMR 注入Joker Runtime
        hmr ? `import {${JOKER_HMR_RUNTIME}} from "@joker.front/core";` : "",
        scriptCodePart,
        templateCodePart,
        styleCodePart
    ].filter(Boolean);

    output.push(
        createHelpCodePart(
            parserResult.hash,
            !!templateCodePart,
            parserResult.descriptor.style?.scoped ? parserResult.hash : undefined,
            hmr
        )
    );

    return {
        code: output.join("\n"),
        joker: {
            lang: "ts"
        }
    };
}

function trasnformScriptImport(filename: string, parserResult: JokerParserResult, hmr: boolean): string {
    let result: Array<string> = [];
    if (parserResult.descriptor.script) {
        const request = JSON.stringify(filename + "?joker&type=script");
        result.push(`import SFC_SCRIPT_EXPORT_DEFAULT from ${request};`);
    } else {
        result.push(
            `import { Component } from "@joker.front/core";`,
            `class SFC_SCRIPT_EXPORT_DEFAULT extends Component {};`
        );
    }

    result.push(`let ${SFC_SCRIPT_EXPORT_DEFAULT} = {
        component:SFC_SCRIPT_EXPORT_DEFAULT
    }`);

    if (hmr) {
        result.push(
            //不需要引入Joker_Runtime，在help中已经引入
            `${JOKER_HMR_RUNTIME}.recordComponent(${JSON.stringify(parserResult.hash)},${SFC_SCRIPT_EXPORT_DEFAULT});`
        );
    }

    return result.join("\n");
}

function trasnformTemplateImport(filename: string, parserResult: JokerParserResult, hmr: boolean): string | undefined {
    if (parserResult.descriptor.template) {
        const request = JSON.stringify(filename + "?joker&type=template");
        let result = [`import ${SFC_TEMPLATE_EXPORT_DEFAULT} from ${request};`];

        if (hmr) {
            result.push(
                //不需要引入Joker_Runtime，在help中已经引入
                `${JOKER_HMR_RUNTIME}.recordRender(${JSON.stringify(
                    parserResult.hash
                )},${SFC_TEMPLATE_EXPORT_DEFAULT});`
            );
        }
        return result.join("\n");
    }
    return "";
}

function trasnformStyleImport(filename: string, descriptor: SFCDescriptor, hash: string): string {
    if (descriptor.style) {
        const request = JSON.stringify(
            filename +
                `?joker&type=style&lang=${descriptor.style.attrs?.lang ?? "css"}${
                    descriptor.style.scoped ? `&scoped=${hash}` : ""
                }`
        );
        return `import  ${request};`;
    }
    return "";
}

function createHelpCodePart(hash: string, hasTemplate: boolean, scoped?: string, hmr?: boolean): string {
    let output = [];

    output.push(`import {JOKER_COMPONENT_TAG} from "@joker.front/core";`);

    if (scoped) {
        output.push(`import {SCOPE_ID as ${SFC_SCOPED_PROPERTY_NAME}} from "@joker.front/core";`);
    }

    if (hmr) {
        output.push(
            `let ${SFC_MAIN} = function(...args){ return new (class extends ${SFC_SCRIPT_EXPORT_DEFAULT}.component {`
        );

        if (scoped) {
            output.push(`[${SFC_SCOPED_PROPERTY_NAME}]= ${JSON.stringify(scoped)};`);
        }

        if (hasTemplate) {
            output.push(`template= ${SFC_TEMPLATE_EXPORT_DEFAULT}.render;`);
        }

        output.push(
            `constructor(...args) {super(...args); ${JOKER_HMR_RUNTIME}.record(${JSON.stringify(hash)},this);}`
        );

        output.push(`})(...args);`);
        output.push(`}`);
        output.push(`${SFC_MAIN}[JOKER_COMPONENT_TAG]= true;`);
    } else {
        output.push(`let ${SFC_MAIN} =class extends ${SFC_SCRIPT_EXPORT_DEFAULT}.component {`);

        if (scoped) {
            output.push(`[${SFC_SCOPED_PROPERTY_NAME}]= ${JSON.stringify(scoped)};`);
        }

        if (hasTemplate) {
            output.push(`template= ${SFC_TEMPLATE_EXPORT_DEFAULT}.render;`);
        }
        output.push(`}`);
    }
    output.push(`export default ${SFC_MAIN};`);

    return output.join("\n");
}

//#endregion

//#region 部分解析
export async function trasnformTemplateAsModule(config: ResolvedConfig, parserResult: JokerParserResult) {
    if (parserResult.descriptor.template && parserResult.descriptor.template.renderStr) {
        /**
         * 注意：这里采用返回对象的问题，是为了HMR广播时变量存在引用关系，通过引用关系做同步
         */
        let code = [
            `let ${SFC_TEMPLATE_EXPORT_DEFAULT}  = { render:function (h) { return ${parserResult.descriptor.template.renderStr}; }};`,

            `export default ${SFC_TEMPLATE_EXPORT_DEFAULT};`
        ];

        if (config.command === "server" && config.server.hmr) {
            code.push(
                `import {${JOKER_HMR_RUNTIME}} from "@joker.front/core";`,
                `import.meta.hot.accept(mod=>{`,
                `   if(!mod && mod.length) return;`,
                `   let newRender= mod[0].default.render;`,
                `   ${JOKER_HMR_RUNTIME}.rerender(${JSON.stringify(parserResult.hash)},newRender);`,
                `});`
            );
        }

        return {
            code: code.join("\n")
        };
    }

    //兜底，理论不会出现该场景
    return {
        code: "export default [];"
    };
}

export async function transformScriptAsModule(
    config: ResolvedConfig,
    code: string,
    filename: string,
    parserResult: JokerParserResult
) {
    let transformResult = await transformWithEsbuild(
        code,
        filename,
        {
            target: "esnext",
            loader: "ts"
        },
        parserResult.descriptor.script?.map
    );

    if (config.command === "server" && config.server.hmr) {
        let hrmCode: string = [
            `import {${JOKER_HMR_RUNTIME}} from "@joker.front/core";`,
            `import.meta.hot.accept(mod=>{`,
            `   if(!mod && mod.length) return;`,
            `   let newComponent= mod[0].default;`,
            `   ${JOKER_HMR_RUNTIME}.reload(${JSON.stringify(parserResult.hash)},newComponent);`,
            `});`
        ].join("\n");

        transformResult.code += "\n" + hrmCode;
    }

    return {
        code: transformResult.code,
        map: transformResult.map || { mappings: "" }
    };
}
//#endregion

interface JokerQuery {
    joker?: boolean;
    type?: "script" | "template" | "style";
    lang?: string;
    scoped?: boolean;
}

/** 转换地址，转换为JokerQuery，方便取值 */
export function parseJokerRequest(id: string): { filename: string; query: JokerQuery } {
    let [filename, strQuery] = id.split("?", 2);

    let queryObj = Object.fromEntries(new URLSearchParams(strQuery));

    let query: JokerQuery = {
        scoped: queryObj.scoped !== undefined,
        joker: queryObj.joker !== undefined,
        type: queryObj.type as any,
        lang: queryObj.lang
    };

    return {
        filename,
        query
    };
}
