import { registerPlugin } from '@capacitor/core';

// src/mobile/localFs/safPlugin.ts
// Kotlin 侧 FoliaFs 插件（SAF: Storage Access Framework）的 JS 类型与入口。
// 原生实现见 android/app/src/main/java/top/izuna/foliamajor/FoliaFsPlugin.kt。
// 契约：目录/文件统一用 content:// URI 标识；scanTree 一次性返回整棵树的相对路径列表，
// readFileRange 以 base64 返回指定字节区间（供懒加载解析，避免整文件过桥）。

export interface SafPickedDirectory {
    /** 已取得持久化读权限的 tree URI */
    uri: string;
    /** 用户可见的目录名（作为导入根目录名） */
    name: string;
}

export interface SafTreeEntry {
    /** 相对根目录的路径，'/' 分隔（如 "Album/Disc 1/song.flac"） */
    path: string;
    name: string;
    isDir: boolean;
    /** 文件字节数；目录为 0 */
    size: number;
    lastModified: number;
    /** 该条目自身的 content:// URI（文件用于按需读取） */
    uri: string;
}

export interface FoliaFsPlugin {
    /** 拉起系统目录选择器；用户取消时 reject */
    pickDirectory(): Promise<SafPickedDirectory>;
    /** 递归列出整棵目录树（一次桥调用，避免逐层 IPC） */
    scanTree(options: { treeUri: string }): Promise<{ entries: SafTreeEntry[] }>;
    /** 读取文件 [offset, offset+length) 字节区间，base64 返回 */
    readFileRange(options: { uri: string; offset: number; length: number }): Promise<{ data: string }>;
    /** 校验对该 tree URI 的持久化读权限是否仍有效 */
    checkPermission(options: { treeUri: string }): Promise<{ granted: boolean }>;
}

export const FoliaFs = registerPlugin<FoliaFsPlugin>('FoliaFs');
