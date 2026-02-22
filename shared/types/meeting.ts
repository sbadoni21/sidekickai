export interface TranscriptSegment {
  id: string;
  text: string;
  timestamp: number;
}

export interface MeetingState {
  id: string;
  startedAt: number;

  transcripts: TranscriptSegment[];
  livePartial: string;

  summary: string;
  lastSummaryIndex: number;

  isRecording: boolean;
}
