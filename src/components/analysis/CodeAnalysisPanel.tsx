/**
 * CodeAnalysisPanel - Displays AI-generated code explanations
 * 
 * Ported from Loom's ExplanationPanel, adapted for Velix styling
 */

import { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { aiService } from '../../services/ai';
import { detectDangerZones, extractImports } from '../../services/analysis';
import './CodeAnalysisPanel.css';

interface CodeAnalysisPanelProps {
    filePath: string;
    fileContent: string;
    onClose: () => void;
}

type ViewMode = 'analysis' | 'chat';

export function CodeAnalysisPanel({ filePath, fileContent, onClose }: CodeAnalysisPanelProps) {
    const [viewMode, setViewMode] = useState<ViewMode>('analysis');
    const [analysis, setAnalysis] = useState<string>('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [chatMessages, setChatMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
    const [chatInput, setChatInput] = useState('');
    const [isChatLoading, setIsChatLoading] = useState(false);

    // Auto-analyze when file changes
    useEffect(() => {
        if (filePath && fileContent) {
            analyzeFile();
        }
    }, [filePath]);

    const analyzeFile = async () => {
        if (!aiService.isProviderReady()) {
            setError('Please configure an AI provider in Settings first.');
            return;
        }

        setIsLoading(true);
        setError(null);
        setAnalysis('');

        try {
            // Extract imports and detect danger zones
            const imports = extractImports(fileContent, filePath);
            const dangerZones = detectDangerZones(fileContent, filePath);

            const result = await aiService.analyzeCode({
                filePath,
                code: fileContent,
                imports,
                dangerZones,
                mode: 'senior',
            });

            setAnalysis(result);
        } catch (err) {
            setError(`Analysis failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
        } finally {
            setIsLoading(false);
        }
    };

    const handleChatSend = async () => {
        if (!chatInput.trim() || isChatLoading) return;

        const userMessage = chatInput.trim();
        setChatInput('');
        setIsChatLoading(true);

        const newMessages = [...chatMessages, { role: 'user' as const, content: userMessage }];
        setChatMessages(newMessages);

        try {
            const response = await aiService.chatAboutCode({
                question: userMessage,
                filePath,
                fileContent,
                previousAnalysis: analysis,
            });

            setChatMessages([...newMessages, { role: 'assistant', content: response }]);
        } catch (err) {
            setChatMessages([
                ...newMessages,
                { role: 'assistant', content: `Error: ${err instanceof Error ? err.message : 'Failed to get response'}` },
            ]);
        } finally {
            setIsChatLoading(false);
        }
    };

    const handleKeyPress = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleChatSend();
        }
    };

    return (
        <div className="code-analysis-panel">
            <div className="analysis-header">
                <div className="analysis-title">
                    <span className="file-icon">F</span>
                    <span className="file-name">{filePath.split('/').pop()}</span>
                </div>
                <div className="analysis-tabs">
                    <button
                        className={`tab-btn ${viewMode === 'analysis' ? 'active' : ''}`}
                        onClick={() => setViewMode('analysis')}
                    >
                        Analysis
                    </button>
                    <button
                        className={`tab-btn ${viewMode === 'chat' ? 'active' : ''}`}
                        onClick={() => setViewMode('chat')}
                    >
                        Chat
                    </button>
                </div>
                <button className="close-btn" onClick={onClose}>×</button>
            </div>

            <div className="analysis-content">
                {viewMode === 'analysis' ? (
                    <div className="analysis-view">
                        {isLoading ? (
                            <div className="loading-state">
                                <div className="loading-spinner"></div>
                                <p>Analyzing code...</p>
                                <p className="loading-hint">This may take a few seconds</p>
                            </div>
                        ) : error ? (
                            <div className="error-state">
                                <p className="error-message">{error}</p>
                                <button className="retry-btn" onClick={analyzeFile}>Retry</button>
                            </div>
                        ) : analysis ? (
                            <div className="markdown-content">
                                <ReactMarkdown>{analysis}</ReactMarkdown>
                            </div>
                        ) : (
                            <div className="empty-state">
                                <p>Click the button below to analyze this file</p>
                                <button className="analyze-btn" onClick={analyzeFile}>Analyze File</button>
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="chat-view">
                        <div className="chat-messages">
                            {chatMessages.length === 0 ? (
                                <div className="chat-empty">
                                    <div className="chat-icon">[C]</div>
                                    <h3>Ask questions about your code</h3>
                                    <p>Get specific answers about functions, classes, architecture, or any aspect of this file.</p>
                                </div>
                            ) : (
                                chatMessages.map((msg, idx) => (
                                    <div key={idx} className={`chat-message ${msg.role}`}>
                                        <div className="message-bubble">
                                            {msg.role === 'assistant' ? (
                                                <ReactMarkdown>{msg.content}</ReactMarkdown>
                                            ) : (
                                                <p>{msg.content}</p>
                                            )}
                                        </div>
                                    </div>
                                ))
                            )}
                            {isChatLoading && (
                                <div className="chat-message assistant">
                                    <div className="message-bubble loading">
                                        <div className="typing-indicator">
                                            <span></span>
                                            <span></span>
                                            <span></span>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                        <div className="chat-input-area">
                            <textarea
                                value={chatInput}
                                onChange={(e) => setChatInput(e.target.value)}
                                onKeyPress={handleKeyPress}
                                placeholder="Ask a question about this code..."
                                disabled={isChatLoading}
                            />
                            <button
                                className="send-btn"
                                onClick={handleChatSend}
                                disabled={!chatInput.trim() || isChatLoading}
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

export default CodeAnalysisPanel;
