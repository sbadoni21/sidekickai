
import { BrowserWindow, screen } from "electron"
import { AppState } from "main"
import fs from "node:fs"
import path from "node:path"

const isDev = process.env.NODE_ENV === "development"

const resolveRendererIndex = () => {
  const candidates = [
    path.join(__dirname, "../dist/index.html"),
    path.join(__dirname, "../../dist/index.html")
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  return candidates[0]
}

const startUrl = isDev
  ? "http://localhost:5180"
  : `file://${resolveRendererIndex()}`

const fallbackFileUrl = `file://${resolveRendererIndex()}`
const MIN_WINDOW_WIDTH = 300
const MIN_WINDOW_HEIGHT = 200

export class WindowHelper {
  private mainWindow: BrowserWindow | null = null
  private isWindowVisible: boolean = false
  private windowPosition: { x: number; y: number } | null = null
  private windowSize: { width: number; height: number } | null = null
  private appState: AppState

  // Initialize with explicit number type and 0 value
  private screenWidth: number = 0
  private screenHeight: number = 0
  private step: number = 0
  private currentX: number = 0
  private currentY: number = 0
  private isApplyingProgrammaticResize: boolean = false
  private manualResizeLocked: boolean = false

  constructor(appState: AppState) {
    this.appState = appState
  }

  private safeApplyWindowFlag(action: () => void, label: string): void {
    try {
      action()
    } catch (error) {
      console.error(`Failed to apply incognito window flag: ${label}`, error)
    }
  }

  public applyIncognitoWindowMode(enabled: boolean): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return

    // Incognito ON: stealth overlay behavior (always-on-top + capture protected).
    // Incognito OFF: normal window behavior (capturable, not forced on top).
    this.safeApplyWindowFlag(() => this.mainWindow?.setContentProtection(enabled), "setContentProtection")
    this.safeApplyWindowFlag(() => this.mainWindow?.setSkipTaskbar(enabled), "setSkipTaskbar")

    if (process.platform === "darwin") {
      this.safeApplyWindowFlag(
        () =>
          this.mainWindow?.setVisibleOnAllWorkspaces(enabled, {
            visibleOnFullScreen: enabled
          }),
        "setVisibleOnAllWorkspaces"
      )
      this.safeApplyWindowFlag(
        () => this.mainWindow?.setHiddenInMissionControl(enabled),
        "setHiddenInMissionControl"
      )
      this.safeApplyWindowFlag(
        () => this.mainWindow?.setAlwaysOnTop(enabled, enabled ? "floating" : "normal"),
        "setAlwaysOnTop:darwin"
      )
      return
    }

    this.safeApplyWindowFlag(() => this.mainWindow?.setAlwaysOnTop(enabled), "setAlwaysOnTop")
  }

  public setWindowDimensions(width: number, height: number): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return
    if (this.manualResizeLocked) return

    const currentBounds = this.mainWindow.getBounds()

    // Get screen dimensions for the display hosting this window.
    const display = screen.getDisplayMatching(currentBounds)
    const workArea = display.workArea

    // Allow wider layouts (Workspace, dashboard) to resize without clipping content.
    const maxAllowedWidth = Math.max(
      420,
      Math.floor(workArea.width * (this.appState.getHasDebugged() ? 0.92 : 0.88))
    )
    const maxAllowedHeight = Math.max(MIN_WINDOW_HEIGHT, workArea.height)

    // Ensure width/height stay in valid bounds.
    const newWidth = Math.max(
      MIN_WINDOW_WIDTH,
      Math.min(Math.ceil(width + 32), maxAllowedWidth)
    )
    const newHeight = Math.max(
      MIN_WINDOW_HEIGHT,
      Math.min(Math.ceil(height), maxAllowedHeight)
    )

    // Keep the top-left corner in the active display work area.
    const minX = workArea.x
    const maxX = workArea.x + workArea.width - newWidth
    const newX = Math.min(Math.max(currentBounds.x, minX), maxX)
    const minY = workArea.y
    const maxY = workArea.y + workArea.height - newHeight
    const newY = Math.min(Math.max(currentBounds.y, minY), maxY)

    // Update window bounds
    this.setBoundsSafely({
      x: newX,
      y: newY,
      width: newWidth,
      height: newHeight
    })

    // Update internal state
    this.windowPosition = { x: newX, y: newY }
    this.windowSize = { width: newWidth, height: newHeight }
    this.currentX = newX
    this.currentY = newY
  }

  public resizeWindowBy(deltaWidth: number, deltaHeight: number): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return
    if (!Number.isFinite(deltaWidth) || !Number.isFinite(deltaHeight)) return

    this.manualResizeLocked = true

    const currentBounds = this.mainWindow.getBounds()
    const display = screen.getDisplayMatching(currentBounds)
    const workArea = display.workArea

    const maxWidthFromPosition = Math.max(
      MIN_WINDOW_WIDTH,
      workArea.x + workArea.width - currentBounds.x
    )
    const maxHeightFromPosition = Math.max(
      MIN_WINDOW_HEIGHT,
      workArea.y + workArea.height - currentBounds.y
    )

    const width = Math.round(currentBounds.width + deltaWidth)
    const height = Math.round(currentBounds.height + deltaHeight)
    const nextWidth = Math.max(MIN_WINDOW_WIDTH, Math.min(width, maxWidthFromPosition))
    const nextHeight = Math.max(
      MIN_WINDOW_HEIGHT,
      Math.min(height, maxHeightFromPosition)
    )

    this.setBoundsSafely({
      x: currentBounds.x,
      y: currentBounds.y,
      width: nextWidth,
      height: nextHeight
    })

    this.windowPosition = { x: currentBounds.x, y: currentBounds.y }
    this.windowSize = { width: nextWidth, height: nextHeight }
  }

  private setBoundsSafely(bounds: {
    x: number
    y: number
    width: number
    height: number
  }): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return
    this.isApplyingProgrammaticResize = true
    try {
      this.mainWindow.setBounds(bounds)
    } finally {
      this.isApplyingProgrammaticResize = false
    }
  }

  public createWindow(): void {
    if (this.mainWindow !== null) return

    const primaryDisplay = screen.getPrimaryDisplay()
    const workArea = primaryDisplay.workAreaSize
    this.screenWidth = workArea.width
    this.screenHeight = workArea.height

    
    const windowSettings: Electron.BrowserWindowConstructorOptions = {
      width: 400,
      height: 600,
      minWidth: MIN_WINDOW_WIDTH,
      minHeight: MIN_WINDOW_HEIGHT,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: true,
        preload: path.join(__dirname, "preload.js")
      },
      show: false, // Start hidden, then show after setup
      alwaysOnTop: this.appState.getIncognitoMode(),
      frame: false,
      transparent: true,
      fullscreenable: false,
      hasShadow: false,
      backgroundColor: "#00000000",
      focusable: true,
      resizable: true,
      movable: true,
      x: 100, // Start at a visible position
      y: 100
    }

    this.mainWindow = new BrowserWindow(windowSettings)
    // this.mainWindow.webContents.openDevTools()

    let hasRecoveredFromLoadFailure = false

    if (process.platform === "linux") {
      // Linux-specific optimizations for better compatibility
      if (this.mainWindow.setHasShadow) {
        this.mainWindow.setHasShadow(false)
      }
      // Keep window focusable on Linux for proper interaction
      this.mainWindow.setFocusable(true)
    }

    this.applyIncognitoWindowMode(this.appState.getIncognitoMode())

    this.mainWindow.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || !this.mainWindow || this.mainWindow.isDestroyed()) return

        console.error(
          `Renderer failed to load (${errorCode}) ${errorDescription} URL=${validatedURL}`
        )

        if (!hasRecoveredFromLoadFailure && validatedURL === startUrl) {
          hasRecoveredFromLoadFailure = true
          console.log(`Attempting fallback renderer load from ${fallbackFileUrl}`)
          this.mainWindow
            .loadURL(fallbackFileUrl)
            .catch((fallbackError) => {
              console.error("Fallback renderer load failed:", fallbackError)
            })
          this.mainWindow.show()
          this.mainWindow.focus()
          this.isWindowVisible = true
          return
        }

        const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#111;color:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;">
    <h2 style="margin:0 0 12px 0;">Renderer failed to load</h2>
    <p style="margin:0 0 8px 0;">URL: ${String(validatedURL || startUrl)}</p>
    <p style="margin:0;">Error: ${String(errorDescription || "Unknown error")} (${Number(errorCode)})</p>
  </body>
</html>`
        const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
        this.mainWindow.loadURL(dataUrl).catch((dataUrlError) => {
          console.error("Error page load failed:", dataUrlError)
        })
        this.mainWindow.show()
        this.mainWindow.focus()
        this.isWindowVisible = true
      }
    )

    this.mainWindow.loadURL(startUrl).catch((err) => {
      console.error("Failed to load URL:", err)
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.show()
        this.mainWindow.focus()
        this.isWindowVisible = true
      }
    })

    // Show window after loading URL and center it
    this.mainWindow.once('ready-to-show', () => {
      if (this.mainWindow) {
        // Center the window first
        this.centerWindow()
        this.mainWindow.show()
        this.mainWindow.focus()
        this.applyIncognitoWindowMode(this.appState.getIncognitoMode())
        console.log("Window is now visible and centered")
      }
    })

    const bounds = this.mainWindow.getBounds()
    this.windowPosition = { x: bounds.x, y: bounds.y }
    this.windowSize = { width: bounds.width, height: bounds.height }
    this.currentX = bounds.x
    this.currentY = bounds.y

    this.setupWindowListeners()
    this.isWindowVisible = true
  }

  private setupWindowListeners(): void {
    if (!this.mainWindow) return

    this.mainWindow.on("move", () => {
      if (this.mainWindow) {
        const bounds = this.mainWindow.getBounds()
        this.windowPosition = { x: bounds.x, y: bounds.y }
        this.currentX = bounds.x
        this.currentY = bounds.y
      }
    })

    this.mainWindow.on("resize", () => {
      if (this.mainWindow) {
        const bounds = this.mainWindow.getBounds()
        this.windowSize = { width: bounds.width, height: bounds.height }
        if (!this.isApplyingProgrammaticResize) {
          this.manualResizeLocked = true
        }
      }
    })

    this.mainWindow.on("closed", () => {
      this.mainWindow = null
      this.isWindowVisible = false
      this.windowPosition = null
      this.windowSize = null
    })
  }

  public getMainWindow(): BrowserWindow | null {
    return this.mainWindow
  }

  public isVisible(): boolean {
    return this.isWindowVisible
  }

  public hideMainWindow(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      console.warn("Main window does not exist or is destroyed.")
      return
    }

    const bounds = this.mainWindow.getBounds()
    this.windowPosition = { x: bounds.x, y: bounds.y }
    this.windowSize = { width: bounds.width, height: bounds.height }
    this.mainWindow.hide()
    this.isWindowVisible = false
  }

  public showMainWindow(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      console.warn("Main window does not exist or is destroyed.")
      return
    }

    if (this.windowPosition && this.windowSize) {
      this.setBoundsSafely({
        x: this.windowPosition.x,
        y: this.windowPosition.y,
        width: this.windowSize.width,
        height: this.windowSize.height
      })
    }

    this.mainWindow.showInactive()
    this.applyIncognitoWindowMode(this.appState.getIncognitoMode())

    this.isWindowVisible = true
  }

  public toggleMainWindow(): void {
    if (this.isWindowVisible) {
      this.hideMainWindow()
    } else {
      this.showMainWindow()
    }
  }

  private centerWindow(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return
    }

    const primaryDisplay = screen.getPrimaryDisplay()
    const workArea = primaryDisplay.workAreaSize
    
    // Get current window size or use defaults
    const windowBounds = this.mainWindow.getBounds()
    const windowWidth = windowBounds.width || 400
    const windowHeight = windowBounds.height || 600
    
    // Calculate center position
    const centerX = Math.floor((workArea.width - windowWidth) / 2)
    const centerY = Math.floor((workArea.height - windowHeight) / 2)
    
    // Set window position
    this.setBoundsSafely({
      x: centerX,
      y: centerY,
      width: windowWidth,
      height: windowHeight
    })
    
    // Update internal state
    this.windowPosition = { x: centerX, y: centerY }
    this.windowSize = { width: windowWidth, height: windowHeight }
    this.currentX = centerX
    this.currentY = centerY
  }

  public centerAndShowWindow(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      console.warn("Main window does not exist or is destroyed.")
      return
    }

    this.centerWindow()
    this.mainWindow.show()
    this.mainWindow.focus()
    this.applyIncognitoWindowMode(this.appState.getIncognitoMode())
    this.isWindowVisible = true
    
    console.log(`Window centered and shown`)
  }

  // New methods for window movement
  public moveWindowRight(): void {
    if (!this.mainWindow) return

    const windowWidth = this.windowSize?.width || 0
    const halfWidth = windowWidth / 2

    // Ensure currentX and currentY are numbers
    this.currentX = Number(this.currentX) || 0
    this.currentY = Number(this.currentY) || 0

    this.currentX = Math.min(
      this.screenWidth - halfWidth,
      this.currentX + this.step
    )
    this.mainWindow.setPosition(
      Math.round(this.currentX),
      Math.round(this.currentY)
    )
  }

  public moveWindowLeft(): void {
    if (!this.mainWindow) return

    const windowWidth = this.windowSize?.width || 0
    const halfWidth = windowWidth / 2

    // Ensure currentX and currentY are numbers
    this.currentX = Number(this.currentX) || 0
    this.currentY = Number(this.currentY) || 0

    this.currentX = Math.max(-halfWidth, this.currentX - this.step)
    this.mainWindow.setPosition(
      Math.round(this.currentX),
      Math.round(this.currentY)
    )
  }

  public moveWindowDown(): void {
    if (!this.mainWindow) return

    const windowHeight = this.windowSize?.height || 0
    const halfHeight = windowHeight / 2

    // Ensure currentX and currentY are numbers
    this.currentX = Number(this.currentX) || 0
    this.currentY = Number(this.currentY) || 0

    this.currentY = Math.min(
      this.screenHeight - halfHeight,
      this.currentY + this.step
    )
    this.mainWindow.setPosition(
      Math.round(this.currentX),
      Math.round(this.currentY)
    )
  }

  public moveWindowUp(): void {
    if (!this.mainWindow) return

    const windowHeight = this.windowSize?.height || 0
    const halfHeight = windowHeight / 2

    // Ensure currentX and currentY are numbers
    this.currentX = Number(this.currentX) || 0
    this.currentY = Number(this.currentY) || 0

    this.currentY = Math.max(-halfHeight, this.currentY - this.step)
    this.mainWindow.setPosition(
      Math.round(this.currentX),
      Math.round(this.currentY)
    )
  }
}
