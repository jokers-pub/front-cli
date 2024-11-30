import { Plugin } from "../plugin";

let DATA_URI_RE = /^([^/]+\/[^;,]+)(;base64)?,([\s\S]*)$/;
let DATA_URI_PRE_FIX = `/@data-uri/`;

export function dataURIPlugin(): Plugin {
    let cache: Record<string, string> = {};

    return {
        name: "joker:data-uri",
        buildStart() {
            cache = {};
        },
        resolveId(source) {
            if (DATA_URI_RE.test(source) === false) return;

            let uri = new URL(source);
            if (uri.protocol !== "data:") return;

            let match = uri.pathname.match(DATA_URI_RE);
            if (!match) return;

            let [, mime, format, data] = match;
            if (mime !== "text/javascript") {
                throw new Error(`不支持非Javascript mime类型的data-URI`);
            }

            let base64 = format && /base64/i.test(format.substring(1));

            let content = base64 ? Buffer.from(data, "base64").toString("utf-8") : data;

            cache[source] = content;

            return DATA_URI_PRE_FIX + source;
        },
        load(id) {
            if (id.startsWith(DATA_URI_PRE_FIX)) {
                id = id.slice(DATA_URI_PRE_FIX.length);

                return cache[id];
            }
        }
    };
}
