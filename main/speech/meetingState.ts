import { MeetingState } from '../../shared/types/meeting';
import { v4 as uuid } from 'uuid';

export const meeting: MeetingState = {
  id: uuid(),
  startedAt: Date.now(),

  transcripts: [],
  livePartial: '',

  summary: '',
  lastSummaryIndex: 0,

  isRecording: false,
};
