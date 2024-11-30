export interface HotModule {
    id: string;
    callbacks: HotCallBack[];
}

export interface HotCallBack {
    deps: string[];
    fn: (modules: Array<ModuleNamespace | undefined>) => void;
}

export type ModuleNamespace = Record<string, any>;
