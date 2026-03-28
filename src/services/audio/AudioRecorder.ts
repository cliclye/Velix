export class AudioRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private stream: MediaStream | null = null;
  private mimeType: string = 'audio/webm';

  private getSupportedMimeType(): string {
    // Try different MIME types in order of preference
    const mimeTypes = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
      'audio/wav',
    ];

    for (const type of mimeTypes) {
      if (MediaRecorder.isTypeSupported(type)) {
        console.log('Using audio MIME type:', type);
        return type;
      }
    }

    // Fallback - let browser choose
    console.log('No preferred MIME type supported, using browser default');
    return '';
  }

  async start(): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioChunks = [];

      this.mimeType = this.getSupportedMimeType();

      const options: MediaRecorderOptions = {};
      if (this.mimeType) {
        options.mimeType = this.mimeType;
      }

      try {
        this.mediaRecorder = new MediaRecorder(this.stream, options);
      } catch (recorderError) {
        // Clean up stream if MediaRecorder creation fails
        this.stream.getTracks().forEach(track => track.stop());
        this.stream = null;
        throw recorderError;
      }

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.start();
      console.log('Recording started with MIME type:', this.mediaRecorder.mimeType);
    } catch (error) {
      // Ensure stream is cleaned up on any error
      if (this.stream) {
        this.stream.getTracks().forEach(track => track.stop());
        this.stream = null;
      }
      console.error('Failed to start recording:', error);
      throw new Error('Failed to access microphone. Please grant permission.');
    }
  }

  async stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      if (!this.mediaRecorder) {
        reject(new Error('No recording in progress'));
        return;
      }

      this.mediaRecorder.onstop = () => {
        // Use the actual MIME type from the recorder
        const actualMimeType = this.mediaRecorder?.mimeType || this.mimeType || 'audio/webm';
        const audioBlob = new Blob(this.audioChunks, { type: actualMimeType });

        console.log('Recording stopped. Blob size:', audioBlob.size, 'Type:', actualMimeType);

        // Stop all tracks
        if (this.stream) {
          this.stream.getTracks().forEach(track => track.stop());
        }

        this.mediaRecorder = null;
        this.stream = null;
        this.audioChunks = [];

        resolve(audioBlob);
      };

      this.mediaRecorder.onerror = (event) => {
        if (this.stream) {
          this.stream.getTracks().forEach(track => track.stop());
        }
        this.mediaRecorder = null;
        this.stream = null;
        this.audioChunks = [];
        reject(new Error(`Recording error: ${(event as ErrorEvent).message || 'unknown'}`));
      };

      this.mediaRecorder.stop();
    });
  }

  isRecording(): boolean {
    return this.mediaRecorder !== null && this.mediaRecorder.state === 'recording';
  }
}
