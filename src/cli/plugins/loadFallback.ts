import { Plugin } from "../plugin";
import { promises as fs } from "node:fs";
import { cleanUrl } from "@joker.front/shared";

export function loadFallbackPlugin(): Plugin {
    return {
        name: "joker:load-fallback",
        async load(id) {
            try {
                return await fs.readFile(cleanUrl(id), "utf-8");
            } catch (e) {
                return fs.readFile(id, "utf-8");
            }
        }
    };
}
