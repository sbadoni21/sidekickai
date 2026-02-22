import { meeting } from './meetingState';

setInterval(async () => {
  const delta = meeting.transcripts.slice(meeting.lastSummaryIndex);
  if (!delta.length) return;

  const text = delta.map(t => t.text).join('\n');

  meeting.summary += '\n' + text; // replace with LLM later
  meeting.lastSummaryIndex = meeting.transcripts.length;
}, 20_000);
