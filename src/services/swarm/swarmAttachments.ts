import { invoke, mkdir, writeBinaryFile } from '../../platform/native';

export type SwarmGoalImage = {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
};

export type PersistedSwarmImage = {
  name: string;
  relativePath: string;
  mimeType: string;
};

const MAX_IMAGES = 5;
const MAX_BYTES = 4 * 1024 * 1024;

export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function readImageFile(file: File): Promise<SwarmGoalImage> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('Only image files are supported.'));
      return;
    }
    if (file.size > MAX_BYTES) {
      reject(new Error(`Image "${file.name}" is too large (max 4 MB).`));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      resolve({
        id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        mimeType: file.type || 'image/png',
        dataUrl: String(reader.result),
      });
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image.'));
    reader.readAsDataURL(file);
  });
}

export async function persistSwarmImages(
  workspacePath: string,
  images: SwarmGoalImage[],
): Promise<PersistedSwarmImage[]> {
  if (images.length === 0) return [];

  const runId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const dir = `${workspacePath}/.velix/swarm-attachments/${runId}`;
  await mkdir(dir, { recursive: true });

  const saved: PersistedSwarmImage[] = [];
  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    const ext = (image.mimeType.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const relativePath = `.velix/swarm-attachments/${runId}/ref-${i + 1}.${ext}`;
    const absolutePath = `${workspacePath}/${relativePath}`;
    await writeBinaryFile(absolutePath, dataUrlToBytes(image.dataUrl));
    saved.push({
      name: image.name,
      relativePath,
      mimeType: image.mimeType,
    });
  }
  return saved;
}

export function augmentSwarmGoal(
  goal: string,
  saved: PersistedSwarmImage[],
  visionSummary?: string,
): string {
  if (saved.length === 0) return goal;

  const lines = [
    goal,
    '',
    '## Reference images attached by user',
    ...saved.map((image, index) => `${index + 1}. \`./${image.relativePath}\` — ${image.name}`),
  ];

  if (visionSummary?.trim()) {
    lines.push('', '## Vision analysis of attached images', visionSummary.trim());
  }

  lines.push(
    '',
    'Agents must inspect these image files on disk when the goal involves UI, mockups, layouts, or visual design.',
  );

  return lines.join('\n');
}

export async function describeSwarmImages(
  images: SwarmGoalImage[],
  apiKey: string,
): Promise<string> {
  if (images.length === 0) return '';

  const content: Array<Record<string, unknown>> = [
    {
      type: 'text',
      text: [
        'You are helping a multi-agent coding swarm understand reference images.',
        'For each image, describe layout, UI components, colors, typography, spacing, and implementation-relevant details.',
        'Number your descriptions to match image order. Be concrete and actionable for software engineers.',
      ].join(' '),
    },
    ...images.map((image) => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.mimeType,
        data: image.dataUrl.includes(',') ? image.dataUrl.split(',')[1] : image.dataUrl,
      },
    })),
  ];

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Vision analysis failed (${response.status}): ${text}`);
  }

  const data = await response.json() as { content?: Array<{ text?: string }> };
  return data.content?.[0]?.text?.trim() ?? '';
}

export async function prepareSwarmGoalWithImages(
  workspacePath: string,
  goalText: string,
  images: SwarmGoalImage[],
  options?: { apiProvider?: string; hasApiKey?: boolean },
): Promise<string> {
  const trimmed = goalText.trim();
  const baseGoal =
    trimmed ||
    (images.length > 0
      ? 'Implement the design and requirements shown in the attached reference images.'
      : '');

  if (images.length === 0) return baseGoal;
  if (images.length > MAX_IMAGES) {
    throw new Error(`Attach at most ${MAX_IMAGES} images per swarm run.`);
  }

  const saved = await persistSwarmImages(workspacePath, images);

  let visionSummary = '';
  if (options?.hasApiKey) {
    try {
      const provider = options.apiProvider || 'claude';
      const apiKey = await invoke<string>('get_api_key', { provider });
      if (apiKey) {
        visionSummary = await describeSwarmImages(images, apiKey);
      }
    } catch (err) {
      console.warn('Swarm image vision analysis skipped:', err);
    }
  }

  return augmentSwarmGoal(baseGoal, saved, visionSummary);
}

export { MAX_IMAGES };
