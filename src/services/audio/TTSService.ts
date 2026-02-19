export type TTSVoice = 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';

export class TTSService {
  private apiKey: string = '';
  private audioContext: AudioContext | null = null;
  private currentSource: AudioBufferSourceNode | null = null;

  setApiKey(key: string) {
    this.apiKey = key;
  }

  async speak(text: string, voice: TTSVoice = 'nova'): Promise<void> {
    if (!this.apiKey) {
      throw new Error('OpenAI API key not configured. Voice features require an OpenAI API key.');
    }

    // Stop any currently playing audio
    this.stop();

    // Truncate very long text to avoid API limits
    const maxLength = 4096;
    const truncatedText = text.length > maxLength
      ? text.substring(0, maxLength) + '...'
      : text;

    console.log('TTS request:', { voice, textLength: truncatedText.length });

    try {
      const response = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'tts-1',
          input: truncatedText,
          voice: voice,
          response_format: 'mp3',
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('TTS API response error:', response.status, errorText);

        if (response.status === 401) {
          throw new Error('Invalid OpenAI API key. Voice features require a valid OpenAI API key.');
        }
        if (response.status === 429) {
          throw new Error('OpenAI rate limit exceeded. Please try again in a moment.');
        }
        throw new Error(`Speech synthesis failed: ${errorText}`);
      }

      const audioData = await response.arrayBuffer();
      console.log('TTS audio received:', audioData.byteLength, 'bytes');
      await this.playAudio(audioData);
    } catch (error) {
      console.error('TTS error:', error);
      throw error;
    }
  }

  private async playAudio(audioData: ArrayBuffer): Promise<void> {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }

    const audioBuffer = await this.audioContext.decodeAudioData(audioData);

    this.currentSource = this.audioContext.createBufferSource();
    this.currentSource.buffer = audioBuffer;
    this.currentSource.connect(this.audioContext.destination);
    this.currentSource.start();

    // Return a promise that resolves when audio finishes
    return new Promise((resolve) => {
      if (this.currentSource) {
        this.currentSource.onended = () => {
          this.currentSource = null;
          resolve();
        };
      } else {
        resolve();
      }
    });
  }

  stop() {
    if (this.currentSource) {
      try {
        this.currentSource.stop();
      } catch (e) {
        // Already stopped
      }
      this.currentSource = null;
    }
  }

  isSpeaking(): boolean {
    return this.currentSource !== null;
  }
}

export const ttsService = new TTSService();
