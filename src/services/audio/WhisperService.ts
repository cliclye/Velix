export class WhisperService {
  private apiKey: string = '';

  setApiKey(key: string) {
    this.apiKey = key;
  }

  private getFileExtension(mimeType: string): string {
    const mimeToExt: Record<string, string> = {
      'audio/webm': 'webm',
      'audio/webm;codecs=opus': 'webm',
      'audio/mp4': 'mp4',
      'audio/ogg': 'ogg',
      'audio/ogg;codecs=opus': 'ogg',
      'audio/wav': 'wav',
      'audio/x-wav': 'wav',
      'audio/mpeg': 'mp3',
    };
    return mimeToExt[mimeType] || 'webm';
  }

  async transcribe(audioBlob: Blob): Promise<string> {
    if (!this.apiKey) {
      throw new Error('OpenAI API key not configured. Voice features require an OpenAI API key.');
    }

    const extension = this.getFileExtension(audioBlob.type);
    const fileName = `audio.${extension}`;

    console.log('Transcribing audio:', {
      size: audioBlob.size,
      type: audioBlob.type,
      fileName
    });

    if (audioBlob.size < 100) {
      throw new Error('Recording too short. Please hold the button longer while speaking.');
    }

    const formData = new FormData();
    formData.append('file', audioBlob, fileName);
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'text');

    try {
      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Whisper API response error:', response.status, errorText);

        if (response.status === 401) {
          throw new Error('Invalid OpenAI API key. Voice features require a valid OpenAI API key.');
        }
        if (response.status === 429) {
          throw new Error('OpenAI rate limit exceeded. Please try again in a moment.');
        }
        throw new Error(`Transcription failed: ${errorText}`);
      }

      const text = await response.text();
      console.log('Transcription result:', text);
      return text.trim();
    } catch (error) {
      console.error('Transcription error:', error);
      throw error;
    }
  }
}

export const whisperService = new WhisperService();
