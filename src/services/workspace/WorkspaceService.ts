import { invoke } from '@tauri-apps/api/core';
import { readTextFile } from '@tauri-apps/plugin-fs';

/**
 * Represents a node in the project file tree.
 */
export interface FileTreeNode {
    path: string;       // Relative path from project root
    name: string;       // File/folder name
    isDirectory: boolean;
    children?: FileTreeNode[];
    size?: number;      // File size in bytes (files only)
    extension?: string; // File extension (files only)
}

/**
 * Workspace context payload sent to the AI.
 * Includes the file tree + selectively loaded file contents.
 */
export interface WorkspaceContext {
    projectDir: string;
    fileTree: FileTreeNode[];
    fileTreeSummary: string;           // Human-readable tree representation
    loadedFiles: Record<string, string>; // relativePath -> content
    totalFiles: number;
    totalLoadedFiles: number;
    totalLoadedSize: number;
}

/**
 * Configuration for workspace scanning.
 */
export interface WorkspaceScanConfig {
    maxTotalSize: number;       // Max total bytes of file contents to load
    maxFileSize: number;        // Max single file size in bytes
    sourceExtensions: string[]; // Extensions to include
    skipDirs: string[];         // Directories to skip
    priorityFiles: string[];   // Files to always load first (e.g., package.json)
}

const DEFAULT_CONFIG: WorkspaceScanConfig = {
    maxTotalSize: 120_000,  // 120KB — fits well within token budgets
    maxFileSize: 15_000,    // 15KB per file
    sourceExtensions: [
        'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
        'css', 'scss', 'less',
        'html', 'htm',
        'json',
        'rs', 'toml',
        'py', 'pyi',
        'go',
        'java', 'kt', 'kts',
        'c', 'cpp', 'h', 'hpp',
        'swift',
        'yaml', 'yml',
        'sh', 'bash', 'zsh',
        'sql',
        'md',
        'vue', 'svelte',
        'graphql', 'gql',
        'proto',
        'tf', 'hcl',
        'dockerfile',
    ],
    skipDirs: [
        'node_modules', '.git', 'target', 'dist', 'build', '.next',
        '.cache', '__pycache__', '.claude', 'coverage', '.turbo',
        '.vscode', '.idea', '.DS_Store', 'vendor', '.svn',
        'out', '.output', '.nuxt', '.vercel', '.netlify',
        'pkg', 'bin', 'obj', '.gradle',
    ],
    priorityFiles: [
        'package.json', 'tsconfig.json', 'Cargo.toml', 'pyproject.toml',
        'go.mod', 'pom.xml', 'build.gradle', 'Makefile', 'CMakeLists.txt',
        'requirements.txt', 'README.md', '.env.example',
    ],
};

/**
 * WorkspaceService manages project-level file awareness.
 *
 * It provides:
 * - Recursive file tree scanning (excluding ignored dirs/binaries)
 * - Prioritized file content loading (config files first, then by relevance)
 * - On-demand file content retrieval
 * - A structured workspace context payload for the AI
 */
export class WorkspaceService {
    private config: WorkspaceScanConfig;
    private cachedContext: WorkspaceContext | null = null;
    private cachedProjectDir: string | null = null;
    private allFilePaths: string[] = [];

    constructor(config?: Partial<WorkspaceScanConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Scan a project directory and build a full workspace context.
     * This is the main entry point — call when a project is opened or refreshed.
     */
    async scan(projectDir: string): Promise<WorkspaceContext> {
        if (!projectDir) {
            throw new Error('No project directory specified');
        }

        // Use Rust backend for fast recursive file listing
        const allFiles = await invoke<string[]>('get_all_files', { directory: projectDir });
        this.allFilePaths = allFiles;

        // Build file tree from flat list
        const fileTree = this.buildFileTree(allFiles);

        // Generate human-readable tree summary
        const fileTreeSummary = this.generateTreeSummary(fileTree);

        // Load file contents with priority ordering
        const { loadedFiles, totalLoadedSize } = await this.loadFileContents(
            projectDir,
            allFiles
        );

        const context: WorkspaceContext = {
            projectDir,
            fileTree,
            fileTreeSummary,
            loadedFiles,
            totalFiles: allFiles.length,
            totalLoadedFiles: Object.keys(loadedFiles).length,
            totalLoadedSize,
        };

        this.cachedContext = context;
        this.cachedProjectDir = projectDir;

        return context;
    }

    /**
     * Get the cached workspace context, or scan if not available.
     */
    async getContext(projectDir: string): Promise<WorkspaceContext> {
        if (this.cachedContext && this.cachedProjectDir === projectDir) {
            return this.cachedContext;
        }
        return this.scan(projectDir);
    }

    /**
     * Retrieve a single file's content on demand.
     * Used when the AI requests a file that wasn't in the initial load.
     */
    async getFileContent(projectDir: string, relativePath: string): Promise<string | null> {
        const fullPath = `${projectDir}/${relativePath}`;
        try {
            const content = await readTextFile(fullPath);
            // Also add to cache
            if (this.cachedContext && this.cachedProjectDir === projectDir) {
                this.cachedContext.loadedFiles[relativePath] = content;
            }
            return content;
        } catch {
            return null;
        }
    }

    /**
     * Get multiple files on demand. Returns a map of relativePath -> content.
     */
    async getFilesContent(projectDir: string, relativePaths: string[]): Promise<Record<string, string>> {
        const result: Record<string, string> = {};
        for (const rp of relativePaths) {
            const content = await this.getFileContent(projectDir, rp);
            if (content !== null) {
                result[rp] = content;
            }
        }
        return result;
    }

    /**
     * Search for files matching a pattern across the project.
     */
    async searchFiles(
        projectDir: string,
        pattern: string,
        caseSensitive: boolean = false,
        maxResults: number = 50
    ): Promise<Array<{ file: string; line: number; column: number; text: string }>> {
        return invoke('search_in_files', {
            directory: projectDir,
            pattern,
            caseSensitive,
            maxResults,
        });
    }

    /**
     * Invalidate the cached context (e.g., after file modifications).
     */
    invalidateCache(): void {
        this.cachedContext = null;
        this.cachedProjectDir = null;
    }

    /**
     * Build the AI system prompt section for workspace context.
     * This is the structured context block that gets embedded in the system prompt.
     */
    buildContextPrompt(context: WorkspaceContext, activeFilePath?: string): string {
        let prompt = `PROJECT WORKSPACE: ${context.projectDir}\n`;
        prompt += `Total files: ${context.totalFiles} | Loaded: ${context.totalLoadedFiles} | Size: ${Math.round(context.totalLoadedSize / 1024)}KB\n\n`;

        // File tree
        prompt += `=== FILE TREE ===\n${context.fileTreeSummary}\n\n`;

        // Loaded file contents
        prompt += `=== LOADED SOURCE FILES ===\n`;
        for (const [filePath, content] of Object.entries(context.loadedFiles)) {
            const ext = filePath.split('.').pop() || 'text';
            const isActive = activeFilePath && filePath === activeFilePath;
            prompt += `\n--- ${filePath}${isActive ? ' [CURRENTLY OPEN]' : ''} ---\n`;
            prompt += `\`\`\`${ext}\n${content}\n\`\`\`\n`;
        }

        // If active file is not in loaded files, note it
        if (activeFilePath && !context.loadedFiles[activeFilePath]) {
            prompt += `\nNote: The currently open file "${activeFilePath}" is not among the pre-loaded files. `;
            prompt += `Its content is provided separately below.\n`;
        }

        // List files that exist but weren't loaded
        const unloadedFiles = this.allFilePaths.filter(
            f => !context.loadedFiles[f]
        );
        if (unloadedFiles.length > 0) {
            prompt += `\n=== OTHER PROJECT FILES (not loaded, available on request) ===\n`;
            prompt += unloadedFiles.slice(0, 200).join('\n');
            if (unloadedFiles.length > 200) {
                prompt += `\n... and ${unloadedFiles.length - 200} more files\n`;
            }
        }

        return prompt;
    }

    // ─── Private Methods ───────────────────────────────────────────────

    /**
     * Internal tree-building node with a children map for efficient insertion.
     */
    private buildFileTree(paths: string[]): FileTreeNode[] {
        interface BuildNode {
            path: string;
            name: string;
            isDirectory: boolean;
            extension?: string;
            childrenMap: Record<string, BuildNode>;
        }

        const rootMap: Record<string, BuildNode> = {};

        for (const filePath of paths) {
            const parts = filePath.split('/');
            let current = rootMap;

            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                const isLast = i === parts.length - 1;
                const currentPath = parts.slice(0, i + 1).join('/');

                if (!current[part]) {
                    current[part] = {
                        path: currentPath,
                        name: part,
                        isDirectory: !isLast,
                        extension: isLast ? part.split('.').pop() : undefined,
                        childrenMap: {},
                    };
                }

                if (!isLast) {
                    current = current[part].childrenMap;
                }
            }
        }

        // Convert the nested BuildNode map into FileTreeNode arrays
        const convert = (map: Record<string, BuildNode>): FileTreeNode[] => {
            return Object.values(map)
                .map((node): FileTreeNode => {
                    const result: FileTreeNode = {
                        path: node.path,
                        name: node.name,
                        isDirectory: node.isDirectory,
                        extension: node.extension,
                    };
                    const childKeys = Object.keys(node.childrenMap);
                    if (childKeys.length > 0) {
                        result.children = convert(node.childrenMap);
                        result.children.sort((a, b) => {
                            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
                            return a.name.localeCompare(b.name);
                        });
                    }
                    return result;
                })
                .sort((a, b) => {
                    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
                    return a.name.localeCompare(b.name);
                });
        };

        return convert(rootMap);
    }

    /**
     * Generate a human-readable tree summary string.
     */
    private generateTreeSummary(tree: FileTreeNode[], prefix: string = '', maxDepth: number = 4, currentDepth: number = 0): string {
        if (currentDepth >= maxDepth) return '';

        let result = '';
        const entries = tree.slice(0, 50); // Limit entries per level
        const hasMore = tree.length > 50;

        for (let i = 0; i < entries.length; i++) {
            const node = entries[i];
            const isLast = i === entries.length - 1 && !hasMore;
            const connector = isLast ? '└── ' : '├── ';
            const childPrefix = isLast ? '    ' : '│   ';

            result += `${prefix}${connector}${node.name}${node.isDirectory ? '/' : ''}\n`;

            if (node.isDirectory && node.children && node.children.length > 0) {
                result += this.generateTreeSummary(
                    node.children,
                    prefix + childPrefix,
                    maxDepth,
                    currentDepth + 1
                );
            }
        }

        if (hasMore) {
            result += `${prefix}└── ... (${tree.length - 50} more)\n`;
        }

        return result;
    }

    /**
     * Load file contents with smart prioritization.
     * Priority order:
     *   1. Config/manifest files (package.json, Cargo.toml, etc.)
     *   2. Entry point files (index.ts, main.rs, app.tsx, etc.)
     *   3. Source files sorted by path depth (shallower = more important)
     */
    private async loadFileContents(
        projectDir: string,
        allFiles: string[]
    ): Promise<{ loadedFiles: Record<string, string>; totalLoadedSize: number }> {
        const loadedFiles: Record<string, string> = {};
        let totalLoadedSize = 0;

        // Filter to source files only
        const sourceFiles = allFiles.filter(f => {
            const lower = f.toLowerCase();
            // Skip ignored directories
            if (this.config.skipDirs.some(d =>
                lower.includes(`/${d}/`) || lower.startsWith(`${d}/`)
            )) return false;
            // Check extension
            const ext = lower.split('.').pop() || '';
            return this.config.sourceExtensions.includes(ext)
                || this.config.priorityFiles.some(pf => lower.endsWith(pf));
        });

        // Prioritize files
        const prioritized = this.prioritizeFiles(sourceFiles);

        // Load files in priority order
        for (const relativePath of prioritized) {
            if (totalLoadedSize >= this.config.maxTotalSize) break;

            const fullPath = `${projectDir}/${relativePath}`;
            try {
                const content = await readTextFile(fullPath);
                if (content.length > this.config.maxFileSize) continue;
                if (totalLoadedSize + content.length > this.config.maxTotalSize) continue;

                loadedFiles[relativePath] = content;
                totalLoadedSize += content.length;
            } catch {
                // Skip unreadable files (binary, permissions, etc.)
            }
        }

        return { loadedFiles, totalLoadedSize };
    }

    /**
     * Sort files by priority for loading.
     */
    private prioritizeFiles(files: string[]): string[] {
        const priority1: string[] = []; // Config/manifest files
        const priority2: string[] = []; // Entry points
        const priority3: string[] = []; // Other source files

        const entryPatterns = [
            /^(src\/)?(index|main|app|lib)\.(ts|tsx|js|jsx|rs|py|go)$/i,
            /^(src\/)?App\.(ts|tsx|js|jsx)$/i,
            /^(src\/)?main\.(ts|tsx|js|jsx|rs|py|go)$/i,
        ];

        for (const file of files) {
            const fileName = file.split('/').pop() || '';

            if (this.config.priorityFiles.some(pf => fileName === pf)) {
                priority1.push(file);
            } else if (entryPatterns.some(p => p.test(file))) {
                priority2.push(file);
            } else {
                priority3.push(file);
            }
        }

        // Sort priority3 by depth (shallower files first)
        priority3.sort((a, b) => {
            const depthA = a.split('/').length;
            const depthB = b.split('/').length;
            if (depthA !== depthB) return depthA - depthB;
            return a.localeCompare(b);
        });

        return [...priority1, ...priority2, ...priority3];
    }
}

// Export singleton instance
export const workspaceService = new WorkspaceService();
