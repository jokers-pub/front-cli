export namespace IHMRType {
    export type All = Connected | Custom | Error | Reload | Prune | Update;

    export interface Connected {
        type: "connected";
        clientId?: string;
    }

    export interface Custom {
        type: "custom";
        clientId?: string;
        event: string;
        data?: any;
    }

    export interface Error {
        type: "error";
        clientId?: string;
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
        clientId?: string;
        path?: string;
        type: "reload";
    }

    export interface Prune {
        clientId?: string;
        type: "prune";
        paths: string[];
    }

    export interface Update {
        clientId?: string;
        type: "update";
        updates: UpdateItem[];
    }

    export interface UpdateItem {
        clientId?: string;
        type: "js-update" | "css-update";
        path: string;
        acceptedPath: string;
        timestamp: number;
    }
}
