/**
 * 本文件旨在寻找真实的根，包括workspace模式，
 * 但只考虑pnpm模式，其余模式不考虑
 */

import { dirname, join } from "node:path";
import fs from "node:fs";

function hasRootFile(root: string): boolean {
    return fs.existsSync(join(root, "pnpm-workspace.yaml"));
}

function hasPackageJSON(root: string): boolean {
    return fs.existsSync(join(root, "package.json"));
}

/**
 * 寻找最近包含package.json的根
 * @param current
 * @param root
 * @returns
 */
export function searchForPackageRoot(current: string, root = current): string {
    if (hasPackageJSON(current)) return current;

    let dir = dirname(current);

    if (!dir || dir === current) return root;

    return searchForPackageRoot(dir, root);
}

/**
 * 寻找最近配置workspace的根
 * @param current
 * @param root
 * @returns
 */
export function searchForWorkspaceRoot(current: string, root = searchForPackageRoot(current)): string {
    if (hasRootFile(current)) return current;

    let dir = dirname(current);

    if (!dir || dir === current) return root;

    return searchForWorkspaceRoot(dir, root);
}
