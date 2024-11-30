import { cleanUrl } from "@joker.front/shared";
import MagicString from "magic-string";
import { ResolvedConfig } from "../config";
import { Plugin } from "../plugin";
import { getFileExtRegex, isCssRequest, isHTMLRequest, isJSONRequest, transformStableResult } from "../utils";
import { parseJokerRequest } from "./joker/transform";

/**
 * build时做define注入插件
 * @param config
 * @returns
 */
export function definePlugin(config: ResolvedConfig): Plugin {
    let replacements: Record<string, string> = {};

    for (let key in config.define) {
        replacements[`import.meta.define.${key}`] = JSON.stringify(config.define[key]);
    }

    if (!config.build.lib) {
        replacements["process.env.NODE_ENV"] = JSON.stringify(process.env.NODE_ENV || config.mode);
        replacements["process.env."] = `({}).`;
    }

    replacements = Object.assign(replacements, {
        //补偿
        "import.meta.define.": "({}).",
        "import.meta.define": JSON.stringify(config.define)
    });

    let replaceRe = getReg(replacements);

    return {
        name: "joker:define",

        transform(code, id) {
            let cleanId = cleanUrl(id);
            //以下类型请求不做处理
            if (
                isCssRequest(cleanId) ||
                isHTMLRequest(cleanId) ||
                getFileExtRegex(config.assetsInclude).test(cleanId) ||
                isJSONRequest(cleanId)
            ) {
                return;
            }

            //过滤掉joker template/style （style 在上面isCssReques已经过滤了）
            let jokerFileInfo = parseJokerRequest(id);
            if (jokerFileInfo.query.joker && jokerFileInfo.query.type === "template") {
                return;
            }

            if (replaceRe === undefined) return;

            let str = new MagicString(code);
            let hasChange = false;
            let match: RegExpExecArray | null;

            while ((match = replaceRe.exec(code))) {
                hasChange = true;

                let start = match.index;
                let end = start + match[0].length;
                let replaceValue = replacements[match[1]] || "";

                str.overwrite(start, end, replaceValue, { contentOnly: true });
            }

            //没有变化则不做处理
            if (hasChange === false) return;

            return transformStableResult(str, id, config);
        }
    };
}

function getReg(replacements: Record<string, string>): RegExp | undefined {
    let replacementsKeys = Object.keys(replacements);

    if (replacementsKeys.length > 0) {
        return new RegExp(
            //前面不能有标识符部分的字符，也不能存在扩展运算符的“.”
            "(?<![\\p{L}\\p{N}_$]|(?<!\\.\\.)\\.)(" +
                replacementsKeys
                    .map((str) => {
                        return str.replace(/[-[\]/{}()*+?.\\^$|]/g, "\\$&");
                    })
                    .join("|") +
                //后面不能存在部分标识符号（但允许使用相等运算符）
                ")(?![\\p{L}\\p{N}_$]|\\s*?=[^=])",
            "gu"
        );
    }

    return;
}
