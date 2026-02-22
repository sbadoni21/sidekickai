// src/speech/streamingSTT.ts

import { SpeechClient } from '@google-cloud/speech';
import { BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';

export type MeetingAudioSource = 'user' | 'interviewer';

interface LiveTranscriptPayload {
  text: string;
  source: MeetingAudioSource;
}

interface StreamingSTTOptions {
  onFinalTranscript?: (payload: LiveTranscriptPayload) => void;
  onPartialTranscript?: (payload: LiveTranscriptPayload) => void;
  onError?: (payload: { source: MeetingAudioSource; message: string }) => void;
}

const DEFAULT_SOURCES: MeetingAudioSource[] = ['user'];

const resolveSpeechClientOptions = (): Record<string, unknown> => {
  const inlineCredentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (inlineCredentials) {
    try {
      const parsed = JSON.parse(inlineCredentials) as {
        client_email?: string;
        private_key?: string;
      };
      if (parsed.client_email && parsed.private_key) {
        console.log('[streamingSTT] Using inline service account credentials.');
        return { credentials: parsed };
      }
      console.warn(
        '[streamingSTT] GOOGLE_SERVICE_ACCOUNT_JSON is set but missing client_email/private_key.'
      );
    } catch (error) {
      console.warn(
        `[streamingSTT] Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  const candidatePaths = [
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    process.env.GOOGLE_CLOUD_KEYFILE,
    path.resolve(process.cwd(), 'google-service-file.json'),
    path.resolve(process.cwd(), '..', 'google-service-file.json'),
  ]
    .filter((candidate): candidate is string => Boolean(candidate && candidate.trim()))
    .map((candidate) => path.resolve(candidate));

  for (const credentialPath of candidatePaths) {
    if (fs.existsSync(credentialPath)) {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialPath;
      console.log(`[streamingSTT] Using service account file: ${credentialPath}`);
      return { keyFilename: credentialPath };
    }
  }

  console.warn(
    '[streamingSTT] No service-account credentials found. Set GOOGLE_APPLICATION_CREDENTIALS or add google-service-file.json.'
  );
  return {};
};

const client = new SpeechClient(resolveSpeechClientOptions());

let recognizeStreams: Partial<Record<MeetingAudioSource, any>> = {};
let activeSources = new Set<MeetingAudioSource>();
let currentWindow: BrowserWindow | null = null;
let streamOptions: StreamingSTTOptions = {};
const firstPCMSeen: Partial<Record<MeetingAudioSource, boolean>> = {};

const isStreamWritable = (stream: any): boolean => {
  if (!stream) return false;
  if (typeof stream.write !== 'function') return false;
  if (typeof stream.destroyed === 'boolean' && stream.destroyed) return false;
  if (typeof stream.writable === 'boolean' && !stream.writable) return false;
  if (typeof stream.closed === 'boolean' && stream.closed) return false;
  if (typeof stream.writableEnded === 'boolean' && stream.writableEnded) return false;
  if (typeof stream.writableFinished === 'boolean' && stream.writableFinished) return false;
  return true;
};

const deactivateSource = (source: MeetingAudioSource, reason: string) => {
  const stream = recognizeStreams[source];
  if (stream) {
    try {
      if (typeof stream.destroy === 'function' && !stream.destroyed) {
        stream.destroy();
      }
    } catch {
      // no-op, stream may already be destroyed
    }
  }

  delete recognizeStreams[source];
  activeSources.delete(source);
  console.warn(`Streaming STT source deactivated (${source}): ${reason}`);
};

const isAudioSource = (value: unknown): value is MeetingAudioSource =>
  value === 'user' || value === 'interviewer';

const normalizeSources = (sources?: MeetingAudioSource[]): MeetingAudioSource[] => {
  const requested = Array.isArray(sources) ? sources.filter(isAudioSource) : [];
  const deduped = Array.from(new Set(requested));
  return deduped.length > 0 ? deduped : DEFAULT_SOURCES;
};

const createRecognitionStream = (source: MeetingAudioSource) => {
  try {
    return client
    .streamingRecognize({
      config: {
        encoding: 'LINEAR16',
        sampleRateHertz: 16000,
        languageCode: 'en-US',
        enableAutomaticPunctuation: true,
      },
      interimResults: true,
    })
    .on('data', (data: any) => {
      const res = data.results?.[0];
      const text = res?.alternatives?.[0]?.transcript?.trim();
      if (!res || !text) return;

      const payload: LiveTranscriptPayload = { text, source };
      if (res.isFinal) {
        console.log(`[FINAL:${source}]`, text);
        streamOptions.onFinalTranscript?.(payload);
        if (currentWindow && !currentWindow.isDestroyed()) {
          currentWindow.webContents.send('meeting:transcript', payload);
        }
      } else {
        console.log(`[PARTIAL:${source}]`, text);
        streamOptions.onPartialTranscript?.(payload);
        if (currentWindow && !currentWindow.isDestroyed()) {
          currentWindow.webContents.send('meeting:partial', payload);
        }
      }
    })
    .on('error', (error: any) => {
      console.error(`Streaming STT error (${source}):`, error);
      const message = error?.message || 'Unknown streaming STT error';
      deactivateSource(source, message);
      streamOptions.onError?.({ source, message });
      if (currentWindow && !currentWindow.isDestroyed()) {
        currentWindow.webContents.send('meeting:error', {
          source,
          message,
        });
      }
    })
    .on('end', () => {
      console.log(`Streaming STT ended (${source})`);
      deactivateSource(source, 'stream ended');
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error || 'Unknown stream init error');
    console.error(`Failed to create streaming STT stream (${source}):`, error);
    streamOptions.onError?.({ source, message });
    if (currentWindow && !currentWindow.isDestroyed()) {
      currentWindow.webContents.send('meeting:error', { source, message });
    }
    return null;
  }
};

export function startStreamingSTT(
  win: BrowserWindow,
  sources?: MeetingAudioSource[],
  options?: StreamingSTTOptions
) {
  if (Object.keys(recognizeStreams).length > 0) {
    console.log('Streaming STT already active, stopping old streams first');
    stopStreamingSTT();
  }

  currentWindow = win;
  streamOptions = options || {};

  const normalizedSources = normalizeSources(sources);
  activeSources = new Set(normalizedSources);
  Object.keys(firstPCMSeen).forEach((key) => {
    delete firstPCMSeen[key as MeetingAudioSource];
  });

  console.log(`Starting streaming STT for sources: ${normalizedSources.join(', ')}`);

  normalizedSources.forEach((source) => {
    const stream = createRecognitionStream(source);
    if (stream) {
      recognizeStreams[source] = stream;
    } else {
      activeSources.delete(source);
    }
  });

  console.log('Streaming STT started successfully');
}

export function stopStreamingSTT() {
  Object.entries(recognizeStreams).forEach(([source, stream]) => {
    if (!stream) return;
    console.log(`Stopping streaming STT (${source})...`);
    try {
      stream.end();
    } catch (error) {
      console.error(`Error ending stream (${source}):`, error);
    }
  });

  recognizeStreams = {};
  activeSources.clear();
  currentWindow = null;
  streamOptions = {};
  Object.keys(firstPCMSeen).forEach((key) => {
    delete firstPCMSeen[key as MeetingAudioSource];
  });
}

export function writePCM(buffer: Buffer, source: MeetingAudioSource = 'user') {
  if (!buffer || buffer.length === 0) return;
  if (!activeSources.has(source)) return;
  if (!firstPCMSeen[source]) {
    firstPCMSeen[source] = true;
    console.log(`Streaming STT received first PCM chunk (${source}, ${buffer.length} bytes)`);
  }

  const stream = recognizeStreams[source];
  if (!stream) {
    activeSources.delete(source);
    return;
  }
  if (!isStreamWritable(stream)) {
    deactivateSource(source, 'stream is not writable');
    return;
  }

  try {
    stream.write(buffer);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error || 'Unknown write error');
    console.error(`Error writing PCM (${source}):`, error);
    deactivateSource(source, message);
  }
}

export function getActiveStreamingSources(): MeetingAudioSource[] {
  return Array.from(activeSources);
}

export function hasActiveStreamingSource(source: MeetingAudioSource): boolean {
  return activeSources.has(source);
}

export function getStreamingWindow(): BrowserWindow | null {
  if (!currentWindow || currentWindow.isDestroyed()) {
    return null;
  }
  return currentWindow;
}
