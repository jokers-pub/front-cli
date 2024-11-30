export namespace IHMRType {
    export type All = Connected | Custom | Error | Reload | Prune | Update;

    export interface Connected {
        type: "connected";
    }

    export interface Custom {
        type: "custom";
        event: string;
        data?: any;
    }

    export interface Error {
        type: "error";
        err: {
            [name: string]: any;
            message: string;
            stack: string;
            id?: string;
            frame?: string;
            plugin?: string;
            pluginCode?: string;

            loc?: {
                file?: string;
                line: number;
                column: number;
            };
        };
    }

    export interface Reload {
        path?: string;
        type: "reload";
    }

    export interface Prune {
        type: "prune";
        paths: string[];
    }

    export interface Update {
        type: "update";
        updates: UpdateItem[];
    }

    export interface UpdateItem {
        type: "js-update" | "css-update";
        path: string;
        acceptedPath: string;
        timestamp: number;
    }
}
