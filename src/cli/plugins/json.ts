import { ResolvedConfig } from "../config";
import { Plugin } from "../plugin";
import { SPECIAL_QUERT_RE, stripBomTag } from "../utils";
import { dataToEsm } from "@rollup/pluginutils";

export function jsonPlugin(): Plugin {
    return {
        name: "joker:json",
        transform(code, id) {
            if (/.json($|\?)(?!commonjs-(proxy|external))/.test(id) === false) return;
            if (SPECIAL_QUERT_RE.test(id)) return;

            code = stripBomTag(code);

            try {
                let parsed = JSON.parse(code);

                return {
                    code: dataToEsm(parsed, {
                        preferConst: true,
                        namedExports: true
                    }),
                    map: { mappings: "" }
                };
            } catch (e: any) {
                let errorMessageList = /[\d]+/.exec(e.message);

                let position = errorMessageList && parseInt(errorMessageList[0], 10);

                this.error(`JSON file parsing failed. ${position ? `Error line: ${position}` : ""}`, e.idx);
            }
        }
    };
}
