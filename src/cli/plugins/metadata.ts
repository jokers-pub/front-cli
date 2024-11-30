import { Plugin } from "../plugin";

export interface JokerChunkMetadata {
    importedAssets: Set<string>;
    importedCss: Set<string>;
}

export function metadataPlugin(): Plugin {
    return {
        name: "joker:metadata",

        renderChunk(_, chunk) {
            (<any>chunk).jokerMetadata = {
                importedAssets: new Set(),
                importedCss: new Set()
            };
            return null;
        }
    };
}
