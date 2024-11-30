import { SFCBlock, SFCDescriptor, SFCScriptBlock } from "@joker.front/sfc";
import { ResolvedConfig } from "../../config";
import { HMRContext, hmrPruned } from "../../server/hmr";
import { ModuleNode } from "../../server/moduleMap";
import { getSFCDescriptor, parserSFCFile, setHotSFCDescriptor } from "./descriptor";
import { Server } from "../../server";
import { parseJokerRequest } from "./transform";

export async function hotUpdate(config: ResolvedConfig, ctx: HMRContext, server: Server): Promise<ModuleNode[] | void> {
    let prevParserResult = getSFCDescriptor(config, ctx.file, false);

    //该请求没有执行过load/transform
    if (prevParserResult === undefined) {
        return;
    }

    setHotSFCDescriptor(config, ctx.file, prevParserResult);

    let code = await ctx.read();
    let parserResult = parserSFCFile(config, ctx.file, code);

    let updateModules = new Set<ModuleNode | undefined>();

    /**
     * 寻找主入口：e.g.
     * aa.joker
     * aa.joker?joker&type=template
     * aa.joker?joker&type=script
     *
     * =====> aa.joker
     *
     * 需要找到主入口，做更新注入 寻找最新的一个
     */
    let entryModule = ctx.modules.find((m) => !/type=/.test(m.url));
    let templateModule = ctx.modules.find((m) => /type=template/.test(m.url));
    let scriptModule = ctx.modules.find((m) => /type=script/.test(m.url));
    let styleModule = ctx.modules.find((m) => {
        if (/type=style/.test(m.url) === false) return false;

        let jokerParam = parseJokerRequest(m.url);

        if (
            jokerParam.query.lang === (parserResult.descriptor.style?.lang || "css") &&
            parserResult.descriptor.style?.scoped === jokerParam.query.scoped
        )
            return true;

        return false;
    });

    let pruneModules = new Set<ModuleNode>();
    ctx.modules.forEach((m) => {
        if ([entryModule, templateModule, scriptModule, styleModule].includes(m) === false) {
            pruneModules.add(m);

            //销毁废弃文件
            server.moduleMap.disposeModule(m);
        }
    });

    //如果有中间废弃文件，则做销毁处理，主要弥补style多文件带来的问题
    pruneModules.size > 0 && hmrPruned(pruneModules, server);

    //script块变更
    if (checkScriptBlockChange(prevParserResult.descriptor, parserResult.descriptor)) {
        //新增或移除
        if (prevParserResult.descriptor.script === undefined || parserResult.descriptor.script === undefined) {
            updateModules.add(entryModule);
        } else {
            updateModules.add(scriptModule || entryModule);
        }
    }

    //template模板变更
    if (checkBlockEqual(parserResult.descriptor.template, prevParserResult.descriptor.template) === false) {
        //新增或移除
        if (prevParserResult.descriptor.template === undefined || parserResult.descriptor.template === undefined) {
            updateModules.add(entryModule);
        } else {
            updateModules.add(templateModule);
        }
    }

    //style变更
    if (checkBlockEqual(parserResult.descriptor.style, prevParserResult.descriptor.style) === false) {
        //新增或移除
        if (
            prevParserResult.descriptor.style === undefined ||
            parserResult.descriptor.style === undefined ||
            //scoped 变更需要触发入口更新
            parserResult.descriptor.style.scoped !== prevParserResult.descriptor.style.scoped
        ) {
            updateModules.add(entryModule);
        } else {
            updateModules.add(styleModule);
        }
    }

    return [...updateModules].filter(Boolean) as ModuleNode[];
}

export function checkBlockEqual(a: SFCBlock | undefined, b: SFCBlock | undefined): boolean {
    if (a === undefined && b === undefined) return true;

    //存在一个underfind 都算不相等
    if (a === undefined || b === undefined) return false;

    if (a.content !== b.content) return false;

    return JSON.stringify(a.attrs) === JSON.stringify(b.attrs);
}

function checkScriptBlockChange(a: SFCDescriptor | undefined, b: SFCDescriptor | undefined): boolean {
    return checkBlockEqual(a?.script, b?.script) === false;
}

export function checkOnlyTemplateBlockChange(a: SFCDescriptor, b: SFCDescriptor): boolean {
    return checkScriptBlockChange(a, b) === false && checkBlockEqual(a.style, b.style);
}
