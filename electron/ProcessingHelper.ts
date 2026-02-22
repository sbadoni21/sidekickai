// ProcessingHelper.ts

import { AppState } from "./main"
import { LLMHelper } from "./LLMHelper"
import dotenv from "dotenv"

dotenv.config()

const isDev = process.env.NODE_ENV === "development"
const isDevTest = process.env.IS_DEV_TEST === "true"
const MOCK_API_WAIT_TIME = Number(process.env.MOCK_API_WAIT_TIME) || 500

export class ProcessingHelper {
  private appState: AppState
  private llmHelper: LLMHelper
  private currentProcessingAbortController: AbortController | null = null
  private currentExtraProcessingAbortController: AbortController | null = null

  constructor(appState: AppState) {
    this.appState = appState

    // API-only mode: local model execution is disabled.
    const requestedOllama = process.env.USE_OLLAMA === "true"
    const ollamaModel = process.env.OLLAMA_MODEL // Don't set default here, let LLMHelper auto-detect
    const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434"
    const groqModel = process.env.GROQ_MODEL
    const groqVisionModel = process.env.GROQ_VISION_MODEL
    const groqBaseUrl = process.env.GROQ_BASE_URL

    if (requestedOllama) {
      console.warn(
        "[ProcessingHelper] USE_OLLAMA=true is ignored because API-only mode is enabled."
      )
    }

    const apiKey = process.env.GROQ_API_KEY
    if (!apiKey) {
      throw new Error(
        "GROQ_API_KEY not found in environment variables. API-only mode requires a cloud key."
      )
    }

    console.log("[ProcessingHelper] Initializing in API-only mode (Groq)")
    this.llmHelper = new LLMHelper(
      apiKey,
      false,
      ollamaModel,
      ollamaUrl,
      groqModel,
      groqVisionModel,
      groqBaseUrl
    )
  }

  public async processScreenshots(): Promise<void> {
    const mainWindow = this.appState.getMainWindow()
    if (!mainWindow) return

    const view = this.appState.getView()

    if (view === "queue") {
      const screenshotQueue = this.appState.getScreenshotHelper().getScreenshotQueue()
      if (screenshotQueue.length === 0) {
        mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.NO_SCREENSHOTS)
        return
      }

      // Check if last screenshot is an audio file
      const allPaths = this.appState.getScreenshotHelper().getScreenshotQueue();
      const lastPath = allPaths[allPaths.length - 1];
      if (lastPath.endsWith('.mp3') || lastPath.endsWith('.wav')) {
        mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.INITIAL_START);
        this.appState.setView('solutions');
        try {
          const audioResult = await this.llmHelper.analyzeAudioFile(lastPath);
          mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.PROBLEM_EXTRACTED, audioResult);
          this.appState.setProblemInfo({ problem_statement: audioResult.text, input_format: {}, output_format: {}, constraints: [], test_cases: [] });
          return;
        } catch (err: any) {
          console.error('Audio processing error:', err);
          mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR, err.message);
          return;
        }
      }

      // NEW: Handle screenshot as plain text (like audio)
      mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.INITIAL_START)
      this.appState.setView("solutions")
      this.currentProcessingAbortController = new AbortController()
      try {
        const imageResult = await this.llmHelper.analyzeImageFile(lastPath);
        const problemInfo = {
          problem_statement: imageResult.text,
          input_format: { description: "Generated from screenshot", parameters: [] as any[] },
          output_format: { description: "Generated from screenshot", type: "string", subtype: "text" },
          complexity: { time: "N/A", space: "N/A" },
          test_cases: [] as any[],
          validation_type: "manual",
          difficulty: "custom"
        };
        mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.PROBLEM_EXTRACTED, problemInfo);
        this.appState.setProblemInfo(problemInfo);
      } catch (error: any) {
        console.error("Image processing error:", error)
        mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR, error.message)
      } finally {
        this.currentProcessingAbortController = null
      }
      return;
    } else {
      // Debug mode
      const extraScreenshotQueue = this.appState.getScreenshotHelper().getExtraScreenshotQueue()
      if (extraScreenshotQueue.length === 0) {
        console.log("No extra screenshots to process")
        mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.NO_SCREENSHOTS)
        return
      }

      mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.DEBUG_START)
      this.currentExtraProcessingAbortController = new AbortController()

      try {
        // Get problem info and current solution
        const problemInfo = this.appState.getProblemInfo()
        if (!problemInfo) {
          throw new Error("No problem info available")
        }

        // Get current solution from state
        const currentSolution = await this.llmHelper.generateSolution(problemInfo)
        const currentCode = currentSolution.solution.code

        // Debug the solution using vision model
        const debugResult = await this.llmHelper.debugSolutionWithImages(
          problemInfo,
          currentCode,
          extraScreenshotQueue
        )

        this.appState.setHasDebugged(true)
        mainWindow.webContents.send(
          this.appState.PROCESSING_EVENTS.DEBUG_SUCCESS,
          debugResult
        )

      } catch (error: any) {
        console.error("Debug processing error:", error)
        mainWindow.webContents.send(
          this.appState.PROCESSING_EVENTS.DEBUG_ERROR,
          error.message
        )
      } finally {
        this.currentExtraProcessingAbortController = null
      }
    }
  }

  public cancelOngoingRequests(): void {
    if (this.currentProcessingAbortController) {
      this.currentProcessingAbortController.abort()
      this.currentProcessingAbortController = null
    }

    if (this.currentExtraProcessingAbortController) {
      this.currentExtraProcessingAbortController.abort()
      this.currentExtraProcessingAbortController = null
    }

    this.appState.setHasDebugged(false)
  }
// Add to ProcessingHelper class

private currentMeeting: any = null;
private meetingProcessingInterval: NodeJS.Timeout | null = null;

// Add these methods to the ProcessingHelper class

public async processMeetingTranscript(
  meeting: any,
  transcript: string,
  source: "user" | "interviewer" = "user"
): Promise<void> {
  try {
    console.log('🤖 [ProcessingHelper] Processing transcript with AI...');
    console.log('📝 [ProcessingHelper] Transcript:', transcript);
    
    const prompt = `Extract a structured note from this meeting transcript.

Transcript: "${transcript}"
Source: "${source}"

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "speaker": "identified speaker or 'Unknown'",
  "type": "discussion/decision/action/question",
  "content": "summarized content",
  "tags": ["tag1", "tag2"]
}`;

    console.log('📡 [ProcessingHelper] Calling LLM API...');
    const response = await this.llmHelper.chat(prompt);
    console.log('📨 [ProcessingHelper] LLM response:', response.substring(0, 200));
    
    // Clean the response - remove markdown code blocks
    const cleanContent = response
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();
    
    console.log('🧹 [ProcessingHelper] Cleaned response:', cleanContent.substring(0, 200));
    
    // Try to parse JSON
    let parsed;
    try {
      parsed = JSON.parse(cleanContent);
    } catch (e) {
      console.error('❌ [ProcessingHelper] Failed to parse JSON, using fallback');
      // Fallback if AI doesn't return valid JSON
      parsed = {
        speaker: source === "interviewer" ? "Interviewer" : "Candidate",
        type: 'discussion',
        content: transcript,
        tags: []
      };
    }

    const note = {
      timestamp: Date.now(),
      speaker: parsed.speaker || (source === "interviewer" ? "Interviewer" : "Candidate"),
      type: parsed.type || 'discussion',
      content: parsed.content || transcript,
      tags: parsed.tags || []
    };

    console.log('📝 [ProcessingHelper] Created note:', note);
    this.appState.addMeetingNote(note);

    // Update mind map every 5 notes
    const currentMeeting = this.appState.getCurrentMeeting();
    if (currentMeeting && currentMeeting.notes.length % 5 === 0) {
      console.log('🗺️ [ProcessingHelper] Updating mind map (5 notes threshold)...');
      await this.updateMeetingMindMap(currentMeeting);
    }
    
    console.log('✅ [ProcessingHelper] Transcript processed successfully');
  } catch (error) {
    console.error('Error processing meeting transcript:', error);
    // Don't throw - just log and continue
  }
}

public async generateMeetingSummary(meeting: any): Promise<any> {
  try {
    console.log('📊 [ProcessingHelper] Generating meeting summary...');
    
    const transcript = meeting.transcripts
      .map((t: any) => t.text)
      .join('\n');

    const prompt = `Analyze this complete meeting transcript and create a comprehensive summary.

Transcript:
${transcript}

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "keyPoints": ["point 1", "point 2"],
  "decisions": ["decision 1", "decision 2"],
  "actionItems": ["action 1", "action 2"],
  "participants": ["person 1", "person 2"],
  "nextSteps": ["step 1", "step 2"]
}`;

    const response = await this.llmHelper.chat(prompt);
    console.log('📨 [ProcessingHelper] Summary response:', response.substring(0, 200));
    
    const cleanContent = response
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleanContent);
    } catch (e) {
      console.error('❌ [ProcessingHelper] Failed to parse summary JSON');
      parsed = {
        keyPoints: ['Summary generation failed'],
        decisions: [],
        actionItems: [],
        participants: [],
        nextSteps: []
      };
    }

    console.log('✅ [ProcessingHelper] Summary generated');
    return parsed;
  } catch (error) {
    console.error('Error generating summary:', error);
    return {
      keyPoints: [],
      decisions: [],
      actionItems: [],
      participants: [],
      nextSteps: []
    };
  }
}

public async generateMeetingMindMap(meeting: any): Promise<any> {
  try {
    console.log('🗺️ [ProcessingHelper] Generating mind map...');
    
    const transcript = meeting.transcripts
      .map((t: any) => t.text)
      .join('\n');

    const prompt = `Create a hierarchical mind map from this meeting transcript.

Transcript:
${transcript}

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "id": "root",
  "label": "Main Topic",
  "children": [
    {
      "id": "topic1",
      "label": "Subtopic 1",
      "children": [
        {"id": "detail1", "label": "Detail 1.1"}
      ]
    }
  ]
}`;

    const response = await this.llmHelper.chat(prompt);
    console.log('📨 [ProcessingHelper] Mind map response:', response.substring(0, 200));
    
    const cleanContent = response
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleanContent);
    } catch (e) {
      console.error('❌ [ProcessingHelper] Failed to parse mind map JSON');
      parsed = {
        id: 'root',
        label: meeting.title || 'Meeting',
        children: []
      };
    }

    console.log('✅ [ProcessingHelper] Mind map generated');
    return parsed;
  } catch (error) {
    console.error('Error generating mind map:', error);
    return {
      id: 'root',
      label: 'Meeting',
      children: []
    };
  }
}

public async updateMeetingMindMap(meeting: any): Promise<void> {
  try {
    console.log('🔄 [ProcessingHelper] Updating mind map...');
    const mindMap = await this.generateMeetingMindMap(meeting);
    this.appState.updateMeetingMindMap(mindMap);
    console.log('✅ [ProcessingHelper] Mind map updated');
  } catch (error) {
    console.error('Error updating mind map:', error);
  }
}
  public async processAudioBase64(data: string, mimeType: string) {
    // Directly use LLMHelper to analyze inline base64 audio
    return this.llmHelper.analyzeAudioFromBase64(data, mimeType);
  }

  // Add audio file processing method
  public async processAudioFile(filePath: string) {
    return this.llmHelper.analyzeAudioFile(filePath);
  }

  public getLLMHelper() {
    return this.llmHelper;
  }
}
