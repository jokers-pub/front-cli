import { ResolvedConfig } from "../../config";
import { Plugin } from "../../plugin";
import { parseJokerRequest, transformJoker, transformScriptAsModule, trasnformTemplateAsModule } from "./transform";
import { getSFCDescriptor, HOT_JOKER_PARSER_CACHE, JOKER_PARSER_CACHE } from "./descriptor";
import { SFCBlock } from "@joker.front/sfc";
import { hotUpdate } from "./hot";
import { browserExternalId } from "../resolve";
import { createFilter } from "../../utils";
import { cleanUrl } from "@joker.front/shared";

export function jokerPlugin(config: ResolvedConfig): Plugin {
    let filter = createFilter(/\.joker$/);

    return {
        name: "joker:sfc-plugin",

        hmrUpdate(ctx, server) {
            if (filter(cleanUrl(ctx.file)) === false) {
                return;
            }

            return hotUpdate(config, ctx, server);
        },

        buildStart(options) {
            JOKER_PARSER_CACHE.set(config, new Map());
            HOT_JOKER_PARSER_CACHE.set(config, new Map());
        },

        resolveId(id, importer, options) {
            if (id.startsWith(browserExternalId)) return;

            let { query } = parseJokerRequest(id);

            if (query.joker) {
                return id;
            }
        },

        load(id) {
            if (id.startsWith(browserExternalId)) return;

            let { filename, query } = parseJokerRequest(id);

            if (query.joker) {
                let sfcDescriptor = getSFCDescriptor(config, filename);
                let block: SFCBlock | undefined;
                if (query.type === "script") {
                    block = sfcDescriptor?.descriptor.script;
                } else if (query.type === "template") {
                    block = sfcDescriptor?.descriptor.template;
                } else if (query.type === "style") {
                    block = sfcDescriptor?.descriptor.style;
                }

                if (block) {
                    return {
                        code: block.content
                    };
                }
            }
        },

        transform(code, id) {
            if (id.startsWith(browserExternalId)) return;
            if (filter(cleanUrl(id)) === false) return;

            let { filename, query } = parseJokerRequest(id);

            if (query.joker) {
                let parserResult = getSFCDescriptor(config, filename);
                if (parserResult === undefined) return;

                if (query.type === "template") {
                    return trasnformTemplateAsModule(config, parserResult!);
                } else if (query.type === "script") {
                    return transformScriptAsModule(config, code, filename, parserResult!);
                }

                //CSS 部分交由其他插件正常处理即可
            } else {
                return transformJoker(config, code, filename);
            }
        }
    };
}
