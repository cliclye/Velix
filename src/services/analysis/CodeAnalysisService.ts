/**
 * CodeAnalysisService - Port of Loom's code analysis functionality
 * 
 * Provides import extraction, project scanning, and dependency graph building
 * for 20+ programming languages.
 */

import { readDir, readTextFile } from "../../platform/native";

// File extension to language mapping
const EXT_TO_LANGUAGE: Record<string, string> = {
    // Tier 1 - Core Languages
    '.py': 'python', '.pyw': 'python', '.pyx': 'python',
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.ts': 'typescript', '.tsx': 'typescript',
    '.java': 'java',
    '.cpp': 'cpp', '.cxx': 'cpp', '.cc': 'cpp', '.c++': 'cpp',
    '.c': 'c', '.h': 'c',
    '.hpp': 'cpp', '.hxx': 'cpp', '.hh': 'cpp',

    // Tier 2 - Strong Additions
    '.go': 'go',
    '.rs': 'rust',
    '.cs': 'csharp',
    '.php': 'php', '.phtml': 'php',
    '.rb': 'ruby', '.rbw': 'ruby',
    '.swift': 'swift',
    '.kt': 'kotlin', '.kts': 'kotlin',

    // Tier 3 - Frontend & Config
    '.html': 'html', '.htm': 'html', '.xhtml': 'html',
    '.css': 'css', '.scss': 'scss', '.sass': 'sass', '.less': 'less',
    '.json': 'json',
    '.yaml': 'yaml', '.yml': 'yaml',
    '.toml': 'toml',
    '.xml': 'xml',

    // Tier 4 - Scripting & Shell
    '.sh': 'bash', '.bash': 'bash', '.zsh': 'zsh',
    '.ps1': 'powershell', '.psm1': 'powershell',

    // Tier 5 - Additional
    '.vue': 'vue', '.svelte': 'svelte',
    '.md': 'markdown', '.markdown': 'markdown',
    '.dart': 'dart',
    '.sql': 'sql',
    '.lua': 'lua',
    '.r': 'r',
    '.scala': 'scala',
};

// Supported code extensions for scanning
const CODE_EXTENSIONS = new Set(Object.keys(EXT_TO_LANGUAGE));

// Directories to skip when scanning
const SKIP_DIRS = new Set([
    'node_modules', '.git', 'venv', '__pycache__', 'build', 'dist',
    'target', '.next', '.nuxt', 'vendor', 'Pods', '.idea', '.vscode'
]);

export interface FileInfo {
    path: string;
    name: string;
    extension: string;
    size: number;
    imports: string[];
    language: string;
}

export interface ProjectData {
    files: FileInfo[];
    dependencies: Record<string, string[]>;
    projectPath: string;
}

export interface DangerZone {
    riskLevel: 'low' | 'medium' | 'high';
    warnings: string[];
    changeFrequency: 'low' | 'medium' | 'high' | 'unknown';
    testCoverage: string;
    complexityIndicators: string[];
}

/**
 * Get the programming language from a file extension
 */
export function getLanguageFromExtension(filePath: string): string {
    const ext = '.' + filePath.split('.').pop()?.toLowerCase();
    return EXT_TO_LANGUAGE[ext] || '';
}

/**
 * Extract imports/dependencies from code based on file extension
 * Ported from Loom's agent.py extract_imports function
 */
export function extractImports(content: string, filePath: string): string[] {
    const imports: string[] = [];
    const ext = '.' + filePath.split('.').pop()?.toLowerCase();

    // Python imports
    if (['.py', '.pyw', '.pyx'].includes(ext)) {
        const pattern = /^(?:import\s+\w+|from\s+\w+(?:\s+import\s+\w+)?)/gm;
        const matches = content.match(pattern) || [];
        imports.push(...matches);
    }

    // JavaScript/TypeScript imports
    else if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) {
        const patterns = [
            /^import\s+.*?from\s+["']([^"']+)["']/gm,
            /^const\s+\w+\s*=\s*require\(["']([^"']+)["']\)/gm,
            /^export\s+.*?from\s+["']([^"']+)["']/gm,
        ];
        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(content)) !== null) {
                imports.push(match[1]);
            }
        }
    }

    // HTML - extract script and link tags
    else if (['.html', '.htm'].includes(ext)) {
        const patterns = [
            /<script\s+[^>]*src=["']([^"']+)["']/gi,
            /<link\s+[^>]*href=["']([^"']+\.(?:css|scss|sass))["']/gi,
        ];
        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(content)) !== null) {
                imports.push(match[1]);
            }
        }
    }

    // CSS/SCSS/SASS imports
    else if (['.css', '.scss', '.sass', '.less'].includes(ext)) {
        const patterns = [
            /@import\s+["']([^"']+)["']/gm,
            /@use\s+["']([^"']+)["']/gm,
        ];
        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(content)) !== null) {
                imports.push(match[1]);
            }
        }
    }

    // Java/Kotlin imports
    else if (['.java', '.kt', '.kts'].includes(ext)) {
        const pattern = /^(?:import|package)\s+([^;]+);/gm;
        let match;
        while ((match = pattern.exec(content)) !== null) {
            imports.push(match[1]);
        }
    }

    // C/C++ includes
    else if (['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx'].includes(ext)) {
        const pattern = /^#include\s+[<"]([^>"]+)[>"]/gm;
        let match;
        while ((match = pattern.exec(content)) !== null) {
            imports.push(match[1]);
        }
    }

    // Go imports
    else if (ext === '.go') {
        const pattern = /import\s+(?:\(|"([^"]+)"|`([^`]+)`)/gm;
        let match;
        while ((match = pattern.exec(content)) !== null) {
            if (match[1]) imports.push(match[1]);
            if (match[2]) imports.push(match[2]);
        }
    }

    // Rust use statements
    else if (ext === '.rs') {
        const pattern = /^(?:use|mod)\s+([^;]+);/gm;
        let match;
        while ((match = pattern.exec(content)) !== null) {
            imports.push(match[1]);
        }
    }

    // Swift imports
    else if (ext === '.swift') {
        const pattern = /^import\s+(\w+)/gm;
        let match;
        while ((match = pattern.exec(content)) !== null) {
            imports.push(match[1]);
        }
    }

    // Vue SFCs
    else if (ext === '.vue') {
        const scriptMatch = content.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
        if (scriptMatch) {
            const scriptContent = scriptMatch[1];
            const pattern = /import\s+.*?from\s+["']([^"']+)["']/gm;
            let match;
            while ((match = pattern.exec(scriptContent)) !== null) {
                imports.push(match[1]);
            }
        }
    }

    return imports.slice(0, 30); // Limit to first 30 imports
}

/**
 * Detect potential danger zones in the code
 * Ported from Loom's agent.py detect_danger_zones function
 */
export function detectDangerZones(
    code: string,
    filePath: string,
    evolution?: { totalFileCommits?: number }
): DangerZone {
    const dangers: DangerZone = {
        riskLevel: 'low',
        warnings: [],
        changeFrequency: 'unknown',
        testCoverage: 'unknown',
        complexityIndicators: [],
    };

    const lines = code.split('\n');

    // Long file check
    if (lines.length > 500) {
        dangers.complexityIndicators.push(`Large file (${lines.length} lines)`);
        dangers.riskLevel = 'medium';
    }

    // Many functions/classes
    const funcCount = (code.match(/\b(?:def|function|class)\s+\w+/g) || []).length;
    if (funcCount > 20) {
        dangers.complexityIndicators.push(`High function/class count (${funcCount})`);
        dangers.riskLevel = 'medium';
    }

    // Nested callbacks / promise chains
    if ((code.match(/\.then\(/g) || []).length > 5 ||
        (code.match(/callback/g) || []).length > 5) {
        dangers.complexityIndicators.push('Complex async patterns detected');
    }

    // TODO/FIXME/HACK comments
    const todoCount = (code.match(/(?:TODO|FIXME|HACK|XXX|BUG):/gi) || []).length;
    if (todoCount > 0) {
        dangers.warnings.push(`${todoCount} TODO/FIXME comments found`);
    }

    // Error handling patterns
    const tryCount = (code.match(/\b(?:try|catch|except|rescue)\b/g) || []).length;
    if (tryCount > 10) {
        dangers.complexityIndicators.push('Heavy error handling');
    }

    // Check evolution for change frequency
    if (evolution?.totalFileCommits) {
        const commits = evolution.totalFileCommits;
        if (commits > 50) {
            dangers.changeFrequency = 'high';
            dangers.warnings.push(`Frequently modified file (${commits} commits)`);
            dangers.riskLevel = 'high';
        } else if (commits > 20) {
            dangers.changeFrequency = 'medium';
        } else {
            dangers.changeFrequency = 'low';
        }
    }

    // Check for test file
    const fileName = filePath.split('/').pop()?.toLowerCase() || '';
    if (fileName.includes('test') || fileName.includes('spec')) {
        dangers.testCoverage = 'this is a test file';
    } else if (code.includes('describe(') || code.includes('it(') || code.includes('def test_')) {
        dangers.testCoverage = 'contains tests';
    } else if (code.includes('jest') || code.includes('pytest') || code.includes('unittest')) {
        dangers.testCoverage = 'has test framework imports';
    } else {
        dangers.testCoverage = 'no tests detected in file';
        dangers.warnings.push('No test coverage detected for this file');
    }

    // Determine final risk level
    if (dangers.warnings.length >= 3 || dangers.changeFrequency === 'high') {
        dangers.riskLevel = 'high';
    } else if (dangers.warnings.length >= 1 || dangers.complexityIndicators.length >= 2) {
        dangers.riskLevel = 'medium';
    }

    return dangers;
}

/**
 * Scan a project directory and return file structure with imports
 */
export async function scanProjectDirectory(
    projectPath: string,
    maxFiles: number = 50
): Promise<ProjectData> {
    const filesData: FileInfo[] = [];
    const dependencies: Record<string, string[]> = {};

    async function scanDir(dirPath: string) {
        if (filesData.length >= maxFiles) return;

        try {
            const entries = await readDir(dirPath);

            for (const entry of entries) {
                if (filesData.length >= maxFiles) break;

                const fullPath = `${dirPath}/${entry.name}`;

                if (entry.isDirectory) {
                    // Skip common non-source directories
                    if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
                        await scanDir(fullPath);
                    }
                } else {
                    // Check if it's a code file
                    const ext = '.' + entry.name.split('.').pop()?.toLowerCase();
                    if (CODE_EXTENSIONS.has(ext)) {
                        try {
                            const content = await readTextFile(fullPath);
                            const imports = extractImports(content, fullPath);
                            const language = getLanguageFromExtension(fullPath);

                            filesData.push({
                                path: fullPath,
                                name: entry.name,
                                extension: ext,
                                size: content.length,
                                imports,
                                language,
                            });

                            dependencies[fullPath] = imports;
                        } catch (err) {
                            console.warn(`Could not read file: ${fullPath}`, err);
                        }
                    }
                }
            }
        } catch (err) {
            console.error(`Error scanning directory: ${dirPath}`, err);
        }
    }

    await scanDir(projectPath);

    return {
        files: filesData,
        dependencies,
        projectPath,
    };
}

/**
 * Code Analysis Service class
 */
export class CodeAnalysisService {
    /**
     * Analyze a single file
     */
    async analyzeFile(filePath: string): Promise<{
        content: string;
        imports: string[];
        language: string;
        dangerZones: DangerZone;
    }> {
        const content = await readTextFile(filePath);
        const imports = extractImports(content, filePath);
        const language = getLanguageFromExtension(filePath);
        const dangerZones = detectDangerZones(content, filePath);

        return { content, imports, language, dangerZones };
    }

    /**
     * Analyze a project directory
     */
    async analyzeProject(projectPath: string): Promise<ProjectData> {
        return scanProjectDirectory(projectPath);
    }

    /**
     * Get language from file path
     */
    getLanguage(filePath: string): string {
        return getLanguageFromExtension(filePath);
    }
}

// Export singleton instance
export const codeAnalysisService = new CodeAnalysisService();
