import { useState } from "react";
import { writeTextFile } from "../platform/native";
import "./CodeEditor.css";

interface CodeEditorProps {
    filePath: string;
    content: string;
    onContentChange?: (content: string) => void;
    onSave: () => void;
    onClose?: () => void;
    tabSize?: number;
}

export function CodeEditor({ filePath, content, onContentChange, onSave, tabSize = 4 }: CodeEditorProps) {
    const [isSaving, setIsSaving] = useState(false);

    const handleKeyDown = async (e: React.KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "s") {
            e.preventDefault();
            saveFile();
        }
    };

    const saveFile = async () => {
        try {
            setIsSaving(true);
            await writeTextFile(filePath, content);
            onSave();
        } catch (err) {
            console.error("Failed to save file:", err);
            alert("Failed to save file");
        } finally {
            setIsSaving(false);
        }
    };

    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        onContentChange?.(e.target.value);
    };

    return (
        <div className="code-editor">
            <div className="editor-content">
                <div className="line-numbers">
                    {content.split('\n').map((_, i) => (
                        <div key={i} className="line-number">{i + 1}</div>
                    ))}
                </div>
                <textarea
                    className="code-input"
                    value={content}
                    onChange={handleChange}
                    onKeyDown={handleKeyDown}
                    spellCheck={false}
                    style={{ tabSize }}
                />
            </div>
            <div className="editor-status">
                <span className="file-path-status">{filePath.split('/').pop()}</span>
                <div className="editor-actions">
                    <button
                        className="editor-btn primary"
                        onClick={saveFile}
                        disabled={isSaving}
                    >
                        {isSaving ? "Saving..." : "Save"}
                    </button>
                </div>
            </div>
        </div>
    );
}
