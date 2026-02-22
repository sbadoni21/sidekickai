// main.ts

import { app, BrowserWindow, Tray, Menu, nativeImage } from "electron"
import { initializeIpcHandlers } from "./ipcHandlers"
import { WindowHelper } from "./WindowHelper"
import { ScreenshotHelper } from "./ScreenshotHelper"
import { ShortcutsHelper } from "./shortcuts"
import { ProcessingHelper } from "./ProcessingHelper"
import { applyRuntimeSecretsToEnv } from "./runtimeSecrets"

// Meeting-related interfaces
interface MeetingNote {
  timestamp: number;
  speaker: string;
  type: string;
  content: string;
  tags: string[];
}

interface MeetingTranscript {
  timestamp: number;
  text: string;
  source?: "user" | "interviewer";
}

interface MeetingSummary {
  keyPoints: string[];
  decisions: string[];
  actionItems: string[];
  participants: string[];
  nextSteps: string[];
}

interface MindMapNode {
  id: string;
  label: string;
  children?: MindMapNode[];
}

interface MeetingAnalytics {
  transcriptSegments?: any[];
  detectedQuestions?: any[];
  answers?: any[];
  controls?: Record<string, unknown>;
  performance?: Record<string, unknown>;
}

interface Meeting {
  id: string;
  title: string;
  startTime: number;
  endTime?: number;
  isRecording: boolean;
  isPaused: boolean;
  notes: MeetingNote[];
  transcripts: MeetingTranscript[];
  analytics?: MeetingAnalytics;
  summary?: MeetingSummary;
  mindMap?: MindMapNode;
}

export class AppState {
  private static instance: AppState | null = null

  private windowHelper: WindowHelper
  private screenshotHelper: ScreenshotHelper
  public shortcutsHelper: ShortcutsHelper
  public processingHelper: ProcessingHelper
  private tray: Tray | null = null

  // View management
  private view: "queue" | "solutions" = "queue"

  private problemInfo: {
    problem_statement: string
    input_format: Record<string, any>
    output_format: Record<string, any>
    constraints: Array<Record<string, any>>
    test_cases: Array<Record<string, any>>
  } | null = null // Allow null

  private hasDebugged: boolean = false

  // Meeting state
  private currentMeeting: Meeting | null = null
  private meetingHistory: Meeting[] = []
  private incognitoMode = false

  // Processing events
  public readonly PROCESSING_EVENTS = {
    //global states
    UNAUTHORIZED: "procesing-unauthorized",
    NO_SCREENSHOTS: "processing-no-screenshots",

    //states for generating the initial solution
    INITIAL_START: "initial-start",
    PROBLEM_EXTRACTED: "problem-extracted",
    SOLUTION_SUCCESS: "solution-success",
    INITIAL_SOLUTION_ERROR: "solution-error",

    //states for processing the debugging
    DEBUG_START: "debug-start",
    DEBUG_SUCCESS: "debug-success",
    DEBUG_ERROR: "debug-error"
  } as const

  // Meeting events
  public readonly MEETING_EVENTS = {
    MINDMAP_UPDATED: "meeting:mindmap-updated",
    NOTE_ADDED: "meeting:note-added",
    TRANSCRIPT_ADDED: "meeting:transcript-added",
    MEETING_STARTED: "meeting:started",
    MEETING_STOPPED: "meeting:stopped",
    MEETING_PAUSED: "meeting:paused",
    MEETING_RESUMED: "meeting:resumed",
  } as const

  public readonly APP_EVENTS = {
    INCOGNITO_MODE_CHANGED: "app:incognito-mode"
  } as const

  constructor() {
    // Initialize WindowHelper with this
    this.windowHelper = new WindowHelper(this)

    // Initialize ScreenshotHelper
    this.screenshotHelper = new ScreenshotHelper(this.view)

    // Initialize ProcessingHelper
    this.processingHelper = new ProcessingHelper(this)

    // Initialize ShortcutsHelper
    this.shortcutsHelper = new ShortcutsHelper(this)
  }

  public static getInstance(): AppState {
    if (!AppState.instance) {
      AppState.instance = new AppState()
    }
    return AppState.instance
  }

  // Getters and Setters
  public getMainWindow(): BrowserWindow | null {
    return this.windowHelper.getMainWindow()
  }

  public getView(): "queue" | "solutions" {
    return this.view
  }

  public setView(view: "queue" | "solutions"): void {
    this.view = view
    this.screenshotHelper.setView(view)
  }

  public isVisible(): boolean {
    return this.windowHelper.isVisible()
  }

  public getScreenshotHelper(): ScreenshotHelper {
    return this.screenshotHelper
  }

  public getProblemInfo(): any {
    return this.problemInfo
  }

  public setProblemInfo(problemInfo: any): void {
    this.problemInfo = problemInfo
  }

  public getScreenshotQueue(): string[] {
    return this.screenshotHelper.getScreenshotQueue()
  }

  public getExtraScreenshotQueue(): string[] {
    return this.screenshotHelper.getExtraScreenshotQueue()
  }

  // Meeting Management Methods
  public getCurrentMeeting(): Meeting | null {
    return this.currentMeeting
  }

  public setCurrentMeeting(meeting: Meeting | null): void {
    this.currentMeeting = meeting
    
    // Notify renderer if meeting state changed
    const mainWindow = this.getMainWindow()
    if (mainWindow) {
      if (meeting) {
        mainWindow.webContents.send(this.MEETING_EVENTS.MEETING_STARTED, meeting)
      } else {
        mainWindow.webContents.send(this.MEETING_EVENTS.MEETING_STOPPED)
      }
    }
  }

  public addMeetingNote(note: MeetingNote): void {
    if (!this.currentMeeting) return
    
    this.currentMeeting.notes.push(note)
    
    // Notify renderer
    const mainWindow = this.getMainWindow()
    if (mainWindow) {
      mainWindow.webContents.send(this.MEETING_EVENTS.NOTE_ADDED, note)
    }
  }

  public addMeetingTranscript(transcript: MeetingTranscript): void {
    if (!this.currentMeeting) return
    
    this.currentMeeting.transcripts.push(transcript)
    
    // Notify renderer
    const mainWindow = this.getMainWindow()
    if (mainWindow) {
      mainWindow.webContents.send(this.MEETING_EVENTS.TRANSCRIPT_ADDED, transcript)
    }
  }

  public updateMeetingMindMap(mindMap: MindMapNode): void {
    if (!this.currentMeeting) return
    
    this.currentMeeting.mindMap = mindMap
    
    // Notify renderer
    const mainWindow = this.getMainWindow()
    if (mainWindow) {
      mainWindow.webContents.send(this.MEETING_EVENTS.MINDMAP_UPDATED, mindMap)
    }
  }

  public pauseMeeting(): void {
    if (!this.currentMeeting) return
    
    this.currentMeeting.isPaused = true
    
    // Notify renderer
    const mainWindow = this.getMainWindow()
    if (mainWindow) {
      mainWindow.webContents.send(this.MEETING_EVENTS.MEETING_PAUSED)
    }
  }

  public resumeMeeting(): void {
    if (!this.currentMeeting) return
    
    this.currentMeeting.isPaused = false
    
    // Notify renderer
    const mainWindow = this.getMainWindow()
    if (mainWindow) {
      mainWindow.webContents.send(this.MEETING_EVENTS.MEETING_RESUMED)
    }
  }

  public finalizeMeeting(summary: MeetingSummary, mindMap: MindMapNode): Meeting | null {
    if (!this.currentMeeting) return null
    
    this.currentMeeting.endTime = Date.now()
    this.currentMeeting.isRecording = false
    this.currentMeeting.summary = summary
    this.currentMeeting.mindMap = mindMap
    
    // Save to history
    this.meetingHistory.push(this.currentMeeting)
    
    const completedMeeting = this.currentMeeting
    this.currentMeeting = null
    
    return completedMeeting
  }

  public getMeetingHistory(): Meeting[] {
    return this.meetingHistory
  }

  public getMeetingById(id: string): Meeting | undefined {
    return this.meetingHistory.find(m => m.id === id)
  }

  public clearMeetingHistory(): void {
    this.meetingHistory = []
  }

  // Window management methods
  public createWindow(): void {
    this.windowHelper.createWindow()
  }

  public hideMainWindow(): void {
    this.windowHelper.hideMainWindow()
  }

  public showMainWindow(): void {
    this.windowHelper.showMainWindow()
  }

  public toggleMainWindow(): void {
    console.log(
      "Screenshots: ",
      this.screenshotHelper.getScreenshotQueue().length,
      "Extra screenshots: ",
      this.screenshotHelper.getExtraScreenshotQueue().length
    )
    this.windowHelper.toggleMainWindow()
  }

  public setWindowDimensions(width: number, height: number): void {
    this.windowHelper.setWindowDimensions(width, height)
  }

  public resizeWindowBy(deltaWidth: number, deltaHeight: number): void {
    this.windowHelper.resizeWindowBy(deltaWidth, deltaHeight)
  }

  public clearQueues(): void {
    this.screenshotHelper.clearQueues()

    // Clear problem info
    this.problemInfo = null

    // Reset view to initial state
    this.setView("queue")
  }

  // Screenshot management methods
  public async takeScreenshot(): Promise<string> {
    if (!this.getMainWindow()) throw new Error("No main window available")

    const screenshotPath = await this.screenshotHelper.takeScreenshot(
      () => this.hideMainWindow(),
      () => this.showMainWindow()
    )

    return screenshotPath
  }

  public async getImagePreview(filepath: string): Promise<string> {
    return this.screenshotHelper.getImagePreview(filepath)
  }

  public async deleteScreenshot(
    path: string
  ): Promise<{ success: boolean; error?: string }> {
    return this.screenshotHelper.deleteScreenshot(path)
  }

  // New methods to move the window
  public moveWindowLeft(): void {
    this.windowHelper.moveWindowLeft()
  }

  public moveWindowRight(): void {
    this.windowHelper.moveWindowRight()
  }

  public moveWindowDown(): void {
    this.windowHelper.moveWindowDown()
  }

  public moveWindowUp(): void {
    this.windowHelper.moveWindowUp()
  }

  public centerAndShowWindow(): void {
    this.windowHelper.centerAndShowWindow()
  }

  public createTray(): void {
    // Create a simple tray icon
    const image = nativeImage.createEmpty()
    
    // Try to use a system template image for better integration
    let trayImage = image
    try {
      // Create a minimal icon - just use an empty image and set the title
      trayImage = nativeImage.createFromBuffer(Buffer.alloc(0))
    } catch (error) {
      console.log("Using empty tray image")
      trayImage = nativeImage.createEmpty()
    }
    
    this.tray = new Tray(trayImage)
    
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show Interview Coder',
        click: () => {
          this.centerAndShowWindow()
        }
      },
      {
        label: 'Toggle Window',
        click: () => {
          this.toggleMainWindow()
        }
      },
      {
        type: 'separator'
      },
      {
        label: 'Take Screenshot (Cmd+H)',
        click: async () => {
          try {
            const screenshotPath = await this.takeScreenshot()
            const preview = await this.getImagePreview(screenshotPath)
            const mainWindow = this.getMainWindow()
            if (mainWindow) {
              mainWindow.webContents.send("screenshot-taken", {
                path: screenshotPath,
                preview
              })
            }
          } catch (error) {
            console.error("Error taking screenshot from tray:", error)
          }
        }
      },
      {
        type: 'separator'
      },
      {
        label: 'Meeting Assistant',
        submenu: [
          {
            label: 'Current Meeting',
            enabled: this.currentMeeting !== null,
            click: () => {
              // Show meeting details
              const mainWindow = this.getMainWindow()
              if (mainWindow && this.currentMeeting) {
                this.showMainWindow()
                mainWindow.webContents.send('show-meeting-details', this.currentMeeting)
              }
            }
          },
          {
            label: 'Meeting History',
            enabled: this.meetingHistory.length > 0,
            click: () => {
              // Show meeting history
              const mainWindow = this.getMainWindow()
              if (mainWindow) {
                this.showMainWindow()
                mainWindow.webContents.send('show-meeting-history', this.meetingHistory)
              }
            }
          }
        ]
      },
      {
        type: 'separator'
      },
      {
        label: 'Quit',
        accelerator: 'Command+Q',
        click: () => {
          app.quit()
        }
      }
    ])
    
    this.tray.setToolTip('Interview Coder - Press Cmd+Shift+Space to show')
    this.tray.setContextMenu(contextMenu)
    
    // Set a title for macOS (will appear in menu bar)
    if (process.platform === 'darwin') {
      this.tray.setTitle('IC')
    }
    
    // Double-click to show window
    this.tray.on('double-click', () => {
      this.centerAndShowWindow()
    })
  }

  public setHasDebugged(value: boolean): void {
    this.hasDebugged = value
  }

  public getHasDebugged(): boolean {
    return this.hasDebugged
  }

  // Utility method to get meeting duration
  public getMeetingDuration(meeting: Meeting): number {
    const endTime = meeting.endTime || Date.now()
    return Math.floor((endTime - meeting.startTime) / 1000)
  }

  // Format duration as HH:MM:SS
  public formatDuration(seconds: number): string {
    const hrs = Math.floor(seconds / 3600)
    const mins = Math.floor((seconds % 3600) / 60)
    const secs = seconds % 60
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }

  public getIncognitoMode(): boolean {
    return this.incognitoMode
  }

  public setIncognitoMode(enabled: boolean): void {
    this.incognitoMode = enabled
    this.windowHelper.applyIncognitoWindowMode(enabled)
    const mainWindow = this.getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(this.APP_EVENTS.INCOGNITO_MODE_CHANGED, enabled)
    }
  }

  public toggleIncognitoMode(): boolean {
    const next = !this.incognitoMode
    this.setIncognitoMode(next)
    return next
  }
}

// Export types for use in other files
export type {
  Meeting,
  MeetingNote,
  MeetingTranscript,
  MeetingSummary,
  MindMapNode
}

// Application initialization
async function initializeApp() {
  applyRuntimeSecretsToEnv()
  const appState = AppState.getInstance()

  // Initialize IPC handlers before window creation
  initializeIpcHandlers(appState)

  // Keep Chromium verbose logging opt-in to avoid noisy terminal output in normal runs.
  if (process.env.ELECTRON_VERBOSE_LOGGING === "1") {
    app.commandLine.appendSwitch("enable-logging")
    app.commandLine.appendSwitch("v", "1")
  }

  app.whenReady().then(() => {
    console.log("App is ready")
    appState.createWindow()
    appState.createTray()
    // Register global shortcuts using ShortcutsHelper
    appState.shortcutsHelper.registerGlobalShortcuts()
  })

  app.on("activate", () => {
    console.log("App activated")
    if (appState.getMainWindow() === null) {
      appState.createWindow()
    }
  })

  // Quit when all windows are closed, except on macOS
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit()
    }
  })

  app.dock?.hide() // Hide dock icon (optional)
  app.commandLine.appendSwitch("disable-background-timer-throttling")
}

// Start the application
initializeApp().catch(console.error)
