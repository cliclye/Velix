import React, { useState, useEffect, useRef } from 'react';
import { AudioRecorder } from '../services/audio/AudioRecorder';
import { whisperService } from '../services/audio/WhisperService';
import { ttsService, TTSVoice } from '../services/audio/TTSService';
import { aiService } from '../services/ai';
import '../styles/VoiceChat.css';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

interface VoiceChatProps {
  apiKey: string;
  onClose: () => void;
}

export const VoiceChat: React.FC<VoiceChatProps> = ({ apiKey, onClose }) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [selectedVoice, setSelectedVoice] = useState<TTSVoice>('nova');
  const [error, setError] = useState<string | null>(null);

  const audioRecorderRef = useRef(new AudioRecorder());
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    whisperService.setApiKey(apiKey);
    ttsService.setApiKey(apiKey);
  }, [apiKey]);

  // Cleanup recording and TTS on unmount
  useEffect(() => {
    return () => {
      audioRecorderRef.current?.stop().catch(() => {});
      ttsService.stop();
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const startRecording = async () => {
    try {
      setError(null);
      await audioRecorderRef.current.start();
      setIsRecording(true);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
    }
  };

  const stopRecording = async () => {
    try {
      setIsRecording(false);
      setIsProcessing(true);
      setError(null);

      const audioBlob = await audioRecorderRef.current.stop();

      if (audioBlob.size < 100) {
        setError('Recording too short. Hold the button longer while speaking.');
        setIsProcessing(false);
        return;
      }

      // Transcribe with Whisper
      const transcription = await whisperService.transcribe(audioBlob);

      if (!transcription || transcription.trim() === '') {
        setError('No speech detected. Try speaking louder or closer to the microphone.');
        setIsProcessing(false);
        return;
      }

      // Add user message
      const userMessage: Message = {
        id: Date.now().toString(),
        role: 'user',
        content: transcription,
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, userMessage]);

      // Get AI response
      const conversationHistory = messages.map(m => ({
        role: m.role,
        content: m.content,
      }));

      const response = await aiService.chat([
        ...conversationHistory,
        { role: 'user', content: transcription },
      ]);

      // Add assistant message
      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: response.content,
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, assistantMessage]);

      setIsProcessing(false);

      // Speak the response
      setIsSpeaking(true);
      await ttsService.speak(response.content, selectedVoice);
      setIsSpeaking(false);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      setIsProcessing(false);
      setIsSpeaking(false);
    }
  };

  const stopSpeaking = () => {
    ttsService.stop();
    setIsSpeaking(false);
  };

  const clearConversation = () => {
    setMessages([]);
    setError(null);
  };

  const voices: { value: TTSVoice; label: string }[] = [
    { value: 'alloy', label: 'Alloy' },
    { value: 'echo', label: 'Echo' },
    { value: 'fable', label: 'Fable' },
    { value: 'onyx', label: 'Onyx' },
    { value: 'nova', label: 'Nova' },
    { value: 'shimmer', label: 'Shimmer' },
  ];

  return (
    <div className="voice-chat">
      <div className="voice-chat-header">
        <h3>Voice Chat</h3>
        <div className="voice-chat-controls">
          <select
            className="voice-select"
            value={selectedVoice}
            onChange={(e) => setSelectedVoice(e.target.value as TTSVoice)}
            disabled={isRecording || isProcessing || isSpeaking}
          >
            {voices.map(voice => (
              <option key={voice.value} value={voice.value}>
                {voice.label}
              </option>
            ))}
          </select>
          <button
            className="clear-btn"
            onClick={clearConversation}
            disabled={messages.length === 0 || isRecording || isProcessing}
          >
            Clear
          </button>
          <button className="close-btn" onClick={onClose}>
            X
          </button>
        </div>
      </div>

      <div className="voice-chat-messages">
        {messages.length === 0 && (
          <div className="empty-state">
            <p>Press and hold the microphone button to start talking</p>
            <p style={{ fontSize: '12px', opacity: 0.7, marginTop: '8px' }}>
              Using OpenAI Whisper for transcription and TTS for speech
            </p>
          </div>
        )}
        {messages.map(message => (
          <div key={message.id} className={`message ${message.role}`}>
            <div className="message-header">
              <span className="message-role">
                {message.role === 'user' ? 'You' : 'AI'}
              </span>
              <span className="message-time">
                {message.timestamp.toLocaleTimeString()}
              </span>
            </div>
            <div className="message-content">{message.content}</div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {error && (
        <div className="voice-chat-error">
          {error}
        </div>
      )}

      <div className="voice-chat-footer">
        <div className="status-indicator">
          {isRecording && <span className="status recording">Recording... Release to send</span>}
          {isProcessing && <span className="status processing">Transcribing with Whisper...</span>}
          {isSpeaking && (
            <div className="status speaking">
              <span>Playing response...</span>
              <button className="stop-speaking-btn" onClick={stopSpeaking}>
                Stop
              </button>
            </div>
          )}
          {!isRecording && !isProcessing && !isSpeaking && (
            <span className="status idle">Ready - Hold button to speak</span>
          )}
        </div>

        <button
          className={`mic-button ${isRecording ? 'recording' : ''}`}
          onMouseDown={startRecording}
          onMouseUp={stopRecording}
          onTouchStart={(e) => { e.preventDefault(); startRecording(); }}
          onTouchEnd={(e) => { e.preventDefault(); stopRecording(); }}
          disabled={isProcessing || isSpeaking}
        >
          {isRecording ? (
            <>
              <span className="mic-icon">MIC</span>
              <span className="mic-label">Release to send</span>
            </>
          ) : (
            <>
              <span className="mic-icon">MIC</span>
              <span className="mic-label">Hold to talk</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
};
