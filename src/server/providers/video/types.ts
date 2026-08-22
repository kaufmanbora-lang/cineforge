import type { AspectRatio, Resolution, VideoModelCapabilities } from "@/domain/video-models";

export interface ReferenceImage {
  id: string;
  data: string;
  mimeType: string;
  role: "subject" | "style" | "first-frame" | "last-frame";
}

export interface VideoGenerationRequest {
  projectId: string;
  sceneId: string;
  shotId: string;
  modelId: string;
  prompt: string;
  negativeDirectives: string[];
  durationSeconds: number;
  resolution: Resolution;
  aspectRatio: AspectRatio;
  seed: number | null;
  references: ReferenceImage[];
  previousInteractionId?: string;
  editInstruction?: string;
}

export interface ProviderOperation {
  provider: "google";
  modelId: string;
  operationId: string;
  state: "pending" | "completed" | "failed";
  progress?: number;
  output?: {
    bytes: Uint8Array;
    mimeType: string;
    providerUri?: string;
    interactionId?: string;
  };
  error?: { code: string; message: string; retryable: boolean };
}

export interface VideoModelAdapter {
  readonly capabilities: VideoModelCapabilities;
  start(request: VideoGenerationRequest, apiKey: string): Promise<ProviderOperation>;
  poll(operation: ProviderOperation, apiKey: string): Promise<ProviderOperation>;
}

export interface PromptAdapter<TIntent = Record<string, unknown>> {
  readonly family: "veo" | "omni";
  build(intent: TIntent): { prompt: string; negativeDirectives: string[] };
  buildEdit(originalPrompt: string, editInstruction: string): string;
}
