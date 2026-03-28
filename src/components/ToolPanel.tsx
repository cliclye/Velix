/**
 * ToolPanel - Integrated panel for Code Analysis, GitHub Analysis, and Chat Mode
 *
 * Ported from Loom's core features (ExplanationPanel, ChatView, GitHub Origins)
 * adapted for the Velix IDE layout and AI service architecture.
 */

import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { aiService } from '../services/ai';
import { extractImports, detectDangerZones, githubService } from '../services/analysis';
import type { GitHubFullAnalysis } from '../services/analysis';
import { readTextFile } from '../platform/native';
import './ToolPanel.css';

type ToolMode = 'analysis' | 'github' | 'chat';

interface ToolPanelProps {
    filePath: string | null;
    fileContent: string;
    projectDir: string;
    onClose: () => void;
}

export function ToolPanel({ filePath, fileContent, projectDir, onClose }: ToolPanelProps) {
    const [mode, setMode] = useState<ToolMode>('analysis');

    // Code Analysis state
    const [analysis, setAnalysis] = useState('');
    const [analysisLoading, setAnalysisLoading] = useState(false);
    const [analysisError, setAnalysisError] = useState<string | null>(null);

    // GitHub state
    const [githubUrl, setGithubUrl] = useState('');
    const [githubData, setGithubData] = useState<GitHubFullAnalysis | null>(null);
    const [githubLoading, setGithubLoading] = useState(false);
    const [githubError, setGithubError] = useState<string | null>(null);

    // Chat state
    const [chatMessages, setChatMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
    const [chatInput, setChatInput] = useState('');
    const [chatLoading, setChatLoading] = useState(false);

    const chatEndRef = useRef<HTMLDivElement>(null);
    const chatInputRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [chatMessages]);

    // === Code Analysis ===
    const runAnalysis = async () => {
        if (!filePath && !projectDir) {
            setAnalysisError('Open a file or project first.');
            return;
        }
        if (!aiService.isProviderReady()) {
            setAnalysisError('Configure an AI provider in Settings first.');
            return;
        }

        setAnalysisLoading(true);
        setAnalysisError(null);
        setAnalysis('');

        try {
            let content = fileContent;
            let path = filePath || '';

            // If no file is open but we have a project dir, analyze project
            if (!filePath && projectDir) {
                const { scanProjectDirectory } = await import('../services/analysis/CodeAnalysisService');
                const projectData = await scanProjectDirectory(projectDir, 30);
                const filesContent = [];
                for (const f of projectData.files.slice(0, 10)) {
                    try {
                        const c = await readTextFile(f.path);
                        filesContent.push({ path: f.path, content: c, imports: f.imports });
                    } catch { /* skip unreadable */ }
                }
                const result = await aiService.analyzeProject({
                    projectData,
                    filesContent,
                    mode: 'senior',
                });
                setAnalysis(result);
                setAnalysisLoading(false);
                return;
            }

            const imports = extractImports(content, path);
            const dangerZones = detectDangerZones(content, path);

            const result = await aiService.analyzeCode({
                filePath: path,
                code: content,
                imports,
                dangerZones,
                mode: 'senior',
            });

            setAnalysis(result);
        } catch (err) {
            setAnalysisError(`Analysis failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
        } finally {
            setAnalysisLoading(false);
        }
    };

    // === GitHub Analysis ===
    const runGithubAnalysis = async () => {
        if (!githubUrl.trim()) {
            setGithubError('Enter a GitHub repository URL.');
            return;
        }
        setGithubLoading(true);
        setGithubError(null);
        setGithubData(null);

        try {
            const data = await githubService.fetchFullAnalysis(githubUrl.trim());
            if (data) {
                setGithubData(data);
            } else {
                setGithubError('Could not fetch repository data. Check the URL and try again.');
            }
        } catch (err) {
            setGithubError(err instanceof Error ? err.message : 'Failed to fetch repository data.');
        } finally {
            setGithubLoading(false);
        }
    };

    // === Chat ===
    const handleChatSend = async () => {
        if (!chatInput.trim() || chatLoading) return;
        if (!aiService.isProviderReady()) return;

        const userMessage = chatInput.trim();
        setChatInput('');
        setChatLoading(true);

        setChatMessages(prev => [...prev, { role: 'user' as const, content: userMessage }]);

        try {
            const response = await aiService.chatAboutCode({
                question: userMessage,
                filePath: filePath || undefined,
                fileContent: fileContent || undefined,
                previousAnalysis: analysis || undefined,
                projectContext: projectDir ? `Project: ${projectDir}` : undefined,
            });
            setChatMessages(prev => [...prev, { role: 'assistant', content: response }]);
        } catch (err) {
            setChatMessages(prev => [
                ...prev,
                { role: 'assistant', content: `Error: ${err instanceof Error ? err.message : 'Failed to get response'}` },
            ]);
        } finally {
            setChatLoading(false);
            chatInputRef.current?.focus();
        }
    };

    const handleChatKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleChatSend();
        }
    };

    // Format number with K/M suffix
    const formatNumber = (n: number): string => {
        if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
        if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
        return n.toString();
    };

    // Format date
    const formatDate = (dateStr: string | null): string => {
        if (!dateStr) return 'N/A';
        return new Date(dateStr).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    };

    // Render GitHub languages bar
    const renderLanguagesBar = (languages: Record<string, number>) => {
        const total = Object.values(languages).reduce((s, v) => s + v, 0);
        if (total === 0) return null;

        const sorted = Object.entries(languages).sort((a, b) => b[1] - a[1]).slice(0, 8);
        const colors = [
            'var(--text-primary)',
            'var(--text-secondary)',
            'var(--text-muted)',
            'var(--border-default)',
            'var(--text-hint)',
            'var(--accent-primary)',
            'var(--accent-primary-dark)',
            'var(--accent-primary-light)',
        ];

        return (
            <div className="tp-languages">
                <div className="tp-lang-bar">
                    {sorted.map(([lang, bytes], index) => (
                        <div
                            key={lang}
                            className="tp-lang-segment"
                            style={{
                                width: `${(bytes / total) * 100}%`,
                                backgroundColor: colors[index % colors.length],
                            }}
                            title={`${lang}: ${((bytes / total) * 100).toFixed(1)}%`}
                        />
                    ))}
                </div>
                <div className="tp-lang-legend">
                    {sorted.map(([lang, bytes], index) => (
                        <div key={lang} className="tp-lang-item">
                            <span className="tp-lang-dot" style={{ backgroundColor: colors[index % colors.length] }} />
                            <span className="tp-lang-name">{lang}</span>
                            <span className="tp-lang-pct">{((bytes / total) * 100).toFixed(1)}%</span>
                        </div>
                    ))}
                </div>
            </div>
        );
    };

    return (
        <div className="tool-panel">
            {/* Header */}
            <div className="tp-header">
                <div className="tp-tabs">
                    <button
                        className={`tp-tab ${mode === 'analysis' ? 'active' : ''}`}
                        onClick={() => setMode('analysis')}
                    >
                        Analysis
                    </button>
                    <button
                        className={`tp-tab ${mode === 'github' ? 'active' : ''}`}
                        onClick={() => setMode('github')}
                    >
                        GitHub
                    </button>
                    <button
                        className={`tp-tab ${mode === 'chat' ? 'active' : ''}`}
                        onClick={() => setMode('chat')}
                    >
                        Chat
                    </button>
                </div>
                <button className="tp-close" onClick={onClose}>x</button>
            </div>

            {/* Content */}
            <div className="tp-content">
                {/* === ANALYSIS MODE === */}
                {mode === 'analysis' && (
                    <div className="tp-analysis">
                        {analysisLoading ? (
                            <div className="tp-center-state">
                                <div className="tp-spinner" />
                                <p>Analyzing{filePath ? ` ${filePath.split('/').pop()}` : ' project'}...</p>
                                <p className="tp-hint">This may take a few seconds</p>
                            </div>
                        ) : analysisError ? (
                            <div className="tp-center-state">
                                <p className="tp-error-text">{analysisError}</p>
                                <button className="tp-action-btn" onClick={runAnalysis}>Retry</button>
                            </div>
                        ) : analysis ? (
                            <div className="tp-markdown">
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>{analysis}</ReactMarkdown>
                            </div>
                        ) : (
                            <div className="tp-center-state">
                                <div className="tp-icon-large">&#128269;</div>
                                <h3>{filePath ? `Analyze ${filePath.split('/').pop()}` : projectDir ? 'Analyze Project' : 'Code Analysis'}</h3>
                                <p className="tp-hint">
                                    {filePath || projectDir
                                        ? 'AI-powered code explanation with risk assessment, architecture analysis, and recommendations.'
                                        : 'Open a file or project to analyze.'}
                                </p>
                                {(filePath || projectDir) && (
                                    <button className="tp-action-btn" onClick={runAnalysis}>
                                        Analyze {filePath ? 'File' : 'Project'}
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                )}

                {/* === GITHUB MODE === */}
                {mode === 'github' && (
                    <div className="tp-github">
                        <div className="tp-github-input-row">
                            <input
                                type="text"
                                className="tp-github-url"
                                value={githubUrl}
                                onChange={e => setGithubUrl(e.target.value)}
                                placeholder="owner/repo or https://github.com/..."
                                onKeyDown={e => { if (e.key === 'Enter') runGithubAnalysis(); }}
                            />
                            <button
                                className="tp-action-btn"
                                onClick={runGithubAnalysis}
                                disabled={githubLoading || !githubUrl.trim()}
                            >
                                {githubLoading ? 'Loading...' : 'Analyze'}
                            </button>
                        </div>

                        {githubError && <div className="tp-error-msg">{githubError}</div>}

                        {githubLoading && (
                            <div className="tp-center-state">
                                <div className="tp-spinner" />
                                <p>Fetching repository data...</p>
                            </div>
                        )}

                        {githubData && !githubLoading && (
                            <div className="tp-github-results">
                                {/* Repository Summary */}
                                <div className="tp-card">
                                    <h3>{githubData.summary.fullName}</h3>
                                    {githubData.summary.description && (
                                        <p className="tp-desc">{githubData.summary.description}</p>
                                    )}
                                    <div className="tp-stats-row">
                                        <span className="tp-stat">Stars {formatNumber(githubData.summary.stars)}</span>
                                        <span className="tp-stat">Forks {formatNumber(githubData.summary.forks)}</span>
                                        {githubData.summary.language && <span className="tp-stat">{githubData.summary.language}</span>}
                                        {githubData.summary.license && <span className="tp-stat">{githubData.summary.license}</span>}
                                    </div>
                                    {githubData.summary.topics.length > 0 && (
                                        <div className="tp-topics">
                                            {githubData.summary.topics.map(t => (
                                                <span key={t} className="tp-topic">{t}</span>
                                            ))}
                                        </div>
                                    )}
                                    <div className="tp-dates">
                                        <span>Created: {formatDate(githubData.summary.createdAt)}</span>
                                        <span>Updated: {formatDate(githubData.summary.updatedAt)}</span>
                                    </div>
                                </div>

                                {/* Quick Stats */}
                                <div className="tp-card">
                                    <h4>Activity</h4>
                                    <div className="tp-quick-stats">
                                        <div className="tp-qstat">
                                            <span className="tp-qstat-val">{formatNumber(githubData.commits.totalCommits)}</span>
                                            <span className="tp-qstat-label">Commits</span>
                                        </div>
                                        <div className="tp-qstat">
                                            <span className="tp-qstat-val">{githubData.contributors.length}</span>
                                            <span className="tp-qstat-label">Contributors</span>
                                        </div>
                                        <div className="tp-qstat">
                                            <span className="tp-qstat-val">{githubData.releases.totalReleases}</span>
                                            <span className="tp-qstat-label">Releases</span>
                                        </div>
                                        <div className="tp-qstat">
                                            <span className="tp-qstat-val">{githubData.branches.length}</span>
                                            <span className="tp-qstat-label">Branches</span>
                                        </div>
                                    </div>
                                </div>

                                {/* Languages */}
                                {Object.keys(githubData.languages).length > 0 && (
                                    <div className="tp-card">
                                        <h4>Languages</h4>
                                        {renderLanguagesBar(githubData.languages)}
                                    </div>
                                )}

                                {/* Contributors */}
                                {githubData.contributors.length > 0 && (
                                    <div className="tp-card">
                                        <h4>Top Contributors</h4>
                                        <div className="tp-contributors">
                                            {githubData.contributors.slice(0, 10).map(c => {
                                                const maxContrib = githubData!.contributors[0]?.contributions || 1;
                                                return (
                                                    <div key={c.username} className="tp-contributor">
                                                        <img src={c.avatarUrl} alt="" className="tp-avatar" />
                                                        <div className="tp-contrib-info">
                                                            <span className="tp-contrib-name">{c.username}</span>
                                                            <div className="tp-contrib-bar-bg">
                                                                <div
                                                                    className="tp-contrib-bar-fill"
                                                                    style={{ width: `${(c.contributions / maxContrib) * 100}%` }}
                                                                />
                                                            </div>
                                                        </div>
                                                        <span className="tp-contrib-count">{c.contributions}</span>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}

                                {/* Branches */}
                                {githubData.branches.length > 0 && (
                                    <div className="tp-card">
                                        <h4>Branches ({githubData.branches.length})</h4>
                                        <div className="tp-branches">
                                            {githubData.branches.slice(0, 10).map(b => (
                                                <div key={b.name} className="tp-branch">
                                                    <span className="tp-branch-name">{b.name}</span>
                                                    {b.protected && <span className="tp-branch-protected">protected</span>}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Releases */}
                                {githubData.releases.totalReleases > 0 && (
                                    <div className="tp-card">
                                        <h4>Releases</h4>
                                        <div className="tp-release-info">
                                            {githubData.releases.latestRelease && (
                                                <div>Latest: <strong>{githubData.releases.latestRelease.tagName}</strong> ({formatDate(githubData.releases.latestRelease.publishedAt)})</div>
                                            )}
                                            {githubData.releases.firstRelease && githubData.releases.firstRelease.tagName !== githubData.releases.latestRelease?.tagName && (
                                                <div>First: <strong>{githubData.releases.firstRelease.tagName}</strong> ({formatDate(githubData.releases.firstRelease.publishedAt)})</div>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}

                {/* === CHAT MODE === */}
                {mode === 'chat' && (
                    <div className="tp-chat">
                        <div className="tp-chat-messages">
                            {chatMessages.length === 0 ? (
                                <div className="tp-center-state">
                                    <div className="tp-icon-large">&#128172;</div>
                                    <h3>Chat about your code</h3>
                                    <p className="tp-hint">
                                        Ask questions about functions, architecture, bugs, or anything about
                                        {filePath ? ` ${filePath.split('/').pop()}` : ' your codebase'}.
                                    </p>
                                </div>
                            ) : (
                                chatMessages.map((msg, idx) => (
                                    <div key={idx} className={`tp-chat-msg ${msg.role}`}>
                                        <div className="tp-chat-bubble">
                                            {msg.role === 'assistant' ? (
                                                <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                                            ) : (
                                                <p>{msg.content}</p>
                                            )}
                                        </div>
                                    </div>
                                ))
                            )}
                            {chatLoading && (
                                <div className="tp-chat-msg assistant">
                                    <div className="tp-chat-bubble">
                                        <div className="tp-typing">
                                            <span /><span /><span />
                                        </div>
                                    </div>
                                </div>
                            )}
                            <div ref={chatEndRef} />
                        </div>
                        <div className="tp-chat-input-area">
                            <textarea
                                ref={chatInputRef}
                                value={chatInput}
                                onChange={e => setChatInput(e.target.value)}
                                onKeyDown={handleChatKeyDown}
                                placeholder={
                                    !aiService.isProviderReady()
                                        ? 'Configure an AI provider in Settings first'
                                        : 'Ask a question about your code...'
                                }
                                disabled={chatLoading || !aiService.isProviderReady()}
                            />
                            <button
                                className="tp-send-btn"
                                onClick={handleChatSend}
                                disabled={!chatInput.trim() || chatLoading || !aiService.isProviderReady()}
                            >
                                Send
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

export default ToolPanel;
