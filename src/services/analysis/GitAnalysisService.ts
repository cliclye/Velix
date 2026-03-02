/**
 * GitAnalysisService - Git-based code analysis
 * 
 * Provides git history, file evolution, remote info, and repository analysis.
 * Uses Tauri commands for git operations.
 */

import { invoke } from '../../platform/native';

export interface GitCommit {
    hash: string;
    message: string;
    author: string;
    date: string;
}

export interface FileEvolution {
    totalFileCommits: number;
    authors: Array<{ name: string; commits: number }>;
    timeline: GitCommit[];
    linesAddedTotal: number;
    linesRemovedTotal: number;
}

export interface GitRemoteInfo {
    remoteUrl: string | null;
    githubRepo: string | null;
    githubUrl: string | null;
    contributors: Array<{ name: string; email: string; commits: number }>;
    totalCommits: number;
    firstCommitDate: string | null;
    branches: string[];
}

/**
 * Git Analysis Service class
 */
export class GitAnalysisService {
    /**
     * Get git commit history for a file
     */
    async getGitHistory(filePath: string): Promise<GitCommit[]> {
        try {
            const history = await invoke<GitCommit[]>('get_git_history', { filePath });
            return history;
        } catch (err) {
            console.warn('Could not get git history:', err);
            return [];
        }
    }

    /**
     * Get file evolution data (authors, changes over time)
     */
    async getFileEvolution(filePath: string): Promise<FileEvolution | null> {
        try {
            const evolution = await invoke<FileEvolution>('get_file_evolution', { filePath });
            return evolution;
        } catch (err) {
            console.warn('Could not get file evolution:', err);
            return null;
        }
    }

    /**
     * Get git remote info (GitHub URL, contributors, etc.)
     */
    async getGitRemoteInfo(repoPath: string): Promise<GitRemoteInfo | null> {
        try {
            const info = await invoke<GitRemoteInfo>('get_git_remote_info', { repoPath });
            return info;
        } catch (err) {
            console.warn('Could not get git remote info:', err);
            return null;
        }
    }

    /**
     * Find the git repository root from a file path
     */
    async findRepoRoot(filePath: string): Promise<string | null> {
        try {
            const root = await invoke<string>('find_repo_root', { filePath });
            return root;
        } catch (err) {
            console.warn('Could not find repo root:', err);
            return null;
        }
    }

    /**
     * Format git history for display
     */
    formatHistory(commits: GitCommit[]): string {
        if (commits.length === 0) return 'No git history found';

        return commits
            .map(c => `${c.hash} - ${c.message} (${c.author}, ${c.date})`)
            .join('\n');
    }
}

// Export singleton instance
export const gitAnalysisService = new GitAnalysisService();
