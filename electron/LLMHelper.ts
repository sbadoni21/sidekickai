import fs from "fs"
import { transcribeAudioBase64, transcribeAudioFile } from "./speechToText"

interface OllamaResponse {
  response: string
  done: boolean
}

interface GroqMessageContentPart {
  type: "text" | "image_url"
  text?: string
  image_url?: {
    url: string
  }
}

interface GroqMessage {
  role: "system" | "user" | "assistant"
  content: string | GroqMessageContentPart[]
}

interface GroqChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null
    }
  }>
  error?: {
    message?: string
  }
}

const DEFAULT_GROQ_BASE_URL = "https://api.groq.com/openai/v1"
const DEFAULT_GROQ_TEXT_MODEL = "llama-3.3-70b-versatile"
const DEFAULT_GROQ_VISION_MODEL = "llama-3.2-11b-vision-preview"

export class LLMHelper {
  private readonly systemPrompt = `You are an interview copilot optimized for live technical interviews.
Default behavior:
- Be concise, high-signal, and spoken-language friendly.
- Prioritize direct answers over long explanations.
- If technical, include approach, complexity, and one key edge case.
- Never output unnecessary markdown wrappers unless explicitly requested.
- If context is ambiguous, ask one short clarifying question or state the assumption clearly.
- Keep responses practical for immediate use during interviews.`
  private useOllama: boolean = false
  private ollamaModel: string = "llama3.2"
  private ollamaUrl: string = "http://localhost:11434"

  private groqApiKey: string = ""
  private groqModel: string = DEFAULT_GROQ_TEXT_MODEL
  private groqVisionModel: string = DEFAULT_GROQ_VISION_MODEL
  private groqBaseUrl: string = DEFAULT_GROQ_BASE_URL

  constructor(
    apiKey?: string,
    useOllama: boolean = false,
    ollamaModel?: string,
    ollamaUrl?: string,
    groqModel?: string,
    groqVisionModel?: string,
    groqBaseUrl?: string
  ) {
    this.useOllama = useOllama

    if (useOllama) {
      this.ollamaUrl = ollamaUrl || "http://localhost:11434"
      this.ollamaModel = ollamaModel || "gemma:latest"
      console.log(`[LLMHelper] Using Ollama with model: ${this.ollamaModel}`)
      this.initializeOllamaModel()
      return
    }

    if (!apiKey) {
      throw new Error("Either provide Groq API key or enable Ollama mode")
    }

    this.groqApiKey = apiKey
    this.groqModel = groqModel || DEFAULT_GROQ_TEXT_MODEL
    this.groqVisionModel = groqVisionModel || DEFAULT_GROQ_VISION_MODEL
    this.groqBaseUrl = groqBaseUrl || DEFAULT_GROQ_BASE_URL
    console.log(`[LLMHelper] Using Groq (${this.groqModel})`)
  }

  private cleanJsonResponse(text: string): string {
    text = text.replace(/^```(?:json)?\n/, "").replace(/\n```$/, "")
    return text.trim()
  }

  private async readImageAsBase64(imagePath: string): Promise<string> {
    const imageData = await fs.promises.readFile(imagePath)
    return imageData.toString("base64")
  }

  private buildGroqHeaders(): Record<string, string> {
    if (!this.groqApiKey) {
      throw new Error("Groq API key is not configured")
    }
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.groqApiKey}`
    }
  }

  private async callGroq(
    messages: GroqMessage[],
    options?: {
      model?: string
      temperature?: number
    }
  ): Promise<string> {
    const model = options?.model || this.groqModel
    const temperature = options?.temperature ?? 0.3

    const response = await fetch(`${this.groqBaseUrl}/chat/completions`, {
      method: "POST",
      headers: this.buildGroqHeaders(),
      body: JSON.stringify({
        model,
        messages,
        temperature
      })
    })

    const body = (await response.json()) as GroqChatResponse
    if (!response.ok) {
      const message = body?.error?.message || `Groq API error: ${response.status}`
      throw new Error(message)
    }

    const content = body?.choices?.[0]?.message?.content
    if (!content) {
      throw new Error("Empty response from Groq")
    }

    return content
  }

  private async callGroqTextPrompt(prompt: string): Promise<string> {
    return this.callGroq(
      [
        { role: "system", content: this.systemPrompt },
        { role: "user", content: prompt }
      ],
      { model: this.groqModel }
    )
  }

  private async callGroqVisionPrompt(prompt: string, imageBase64List: string[]): Promise<string> {
    if (imageBase64List.length === 0) {
      return this.callGroqTextPrompt(prompt)
    }

    const content: GroqMessageContentPart[] = [{ type: "text", text: prompt }]
    for (const imageBase64 of imageBase64List) {
      content.push({
        type: "image_url",
        image_url: {
          url: `data:image/png;base64,${imageBase64}`
        }
      })
    }

    return this.callGroq(
      [
        { role: "system", content: this.systemPrompt },
        { role: "user", content }
      ],
      { model: this.groqVisionModel }
    )
  }

  private async callOllama(prompt: string): Promise<string> {
    try {
      const response = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: this.ollamaModel,
          prompt,
          stream: false,
          options: {
            temperature: 0.7,
            top_p: 0.9
          }
        })
      })

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`)
      }

      const data: OllamaResponse = await response.json()
      return data.response
    } catch (error: any) {
      console.error("[LLMHelper] Error calling Ollama:", error)
      throw new Error(
        `Failed to connect to Ollama: ${error.message}. Make sure Ollama is running on ${this.ollamaUrl}`
      )
    }
  }

  private async checkOllamaAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.ollamaUrl}/api/tags`)
      return response.ok
    } catch {
      return false
    }
  }

  private async initializeOllamaModel(): Promise<void> {
    try {
      const availableModels = await this.getOllamaModels()
      if (availableModels.length === 0) {
        console.warn("[LLMHelper] No Ollama models found")
        return
      }

      if (!availableModels.includes(this.ollamaModel)) {
        this.ollamaModel = availableModels[0]
        console.log(`[LLMHelper] Auto-selected first available model: ${this.ollamaModel}`)
      }

      await this.callOllama("Hello")
      console.log(`[LLMHelper] Successfully initialized with model: ${this.ollamaModel}`)
    } catch (error: any) {
      console.error(`[LLMHelper] Failed to initialize Ollama model: ${error.message}`)
      try {
        const models = await this.getOllamaModels()
        if (models.length > 0) {
          this.ollamaModel = models[0]
          console.log(`[LLMHelper] Fallback to: ${this.ollamaModel}`)
        }
      } catch (fallbackError: any) {
        console.error(`[LLMHelper] Fallback also failed: ${fallbackError.message}`)
      }
    }
  }

  public async extractProblemFromImages(imagePaths: string[]) {
    try {
      if (this.useOllama) {
        throw new Error("Image analysis is not supported in Ollama mode in this app.")
      }

      const imageBase64List = await Promise.all(imagePaths.map(path => this.readImageAsBase64(path)))
      const prompt = `Analyze these images and extract the following information in JSON format:
{
  "problem_statement": "A clear statement of the problem or situation depicted in the images.",
  "context": "Relevant background or context from the images.",
  "suggested_responses": ["First possible answer or action", "Second possible answer or action", "..."],
  "reasoning": "Explanation of why these suggestions are appropriate."
}
Important: Return ONLY the JSON object, without markdown formatting or code blocks.`

      const raw = await this.callGroqVisionPrompt(prompt, imageBase64List)
      return JSON.parse(this.cleanJsonResponse(raw))
    } catch (error) {
      console.error("Error extracting problem from images:", error)
      throw error
    }
  }

  public async generateSolution(problemInfo: any) {
    const prompt = `Given this problem or situation:
${JSON.stringify(problemInfo, null, 2)}

Please provide your response in the following JSON format:
{
  "solution": {
    "code": "The code or main answer here.",
    "problem_statement": "Restate the problem or situation.",
    "context": "Relevant background/context.",
    "suggested_responses": ["First possible answer or action", "Second possible answer or action", "..."],
    "reasoning": "Explanation of why these suggestions are appropriate."
  }
}
Important: Return ONLY the JSON object, without markdown formatting or code blocks.`

    console.log("[LLMHelper] Generating solution...")
    try {
      const raw = this.useOllama
        ? await this.callOllama(prompt)
        : await this.callGroqTextPrompt(prompt)
      const parsed = JSON.parse(this.cleanJsonResponse(raw))
      console.log("[LLMHelper] Parsed LLM response:", parsed)
      return parsed
    } catch (error) {
      console.error("[LLMHelper] Error in generateSolution:", error)
      throw error
    }
  }

  public async debugSolutionWithImages(problemInfo: any, currentCode: string, debugImagePaths: string[]) {
    try {
      if (this.useOllama) {
        throw new Error("Debug with images is not supported in Ollama mode in this app.")
      }

      const imageBase64List = await Promise.all(debugImagePaths.map(path => this.readImageAsBase64(path)))

      const prompt = `Given:
1. The original problem or situation: ${JSON.stringify(problemInfo, null, 2)}
2. The current response or approach: ${currentCode}
3. The debug information in the provided images

Please analyze the debug information and provide feedback in this JSON format:
{
  "solution": {
    "code": "The code or main answer here.",
    "problem_statement": "Restate the problem or situation.",
    "context": "Relevant background/context.",
    "suggested_responses": ["First possible answer or action", "Second possible answer or action", "..."],
    "reasoning": "Explanation of why these suggestions are appropriate."
  }
}
Important: Return ONLY the JSON object, without markdown formatting or code blocks.`

      const raw = await this.callGroqVisionPrompt(prompt, imageBase64List)
      const parsed = JSON.parse(this.cleanJsonResponse(raw))
      console.log("[LLMHelper] Parsed debug LLM response:", parsed)
      return parsed
    } catch (error) {
      console.error("Error debugging solution with images:", error)
      throw error
    }
  }

  public async analyzeAudioFile(audioPath: string) {
    try {
      const transcript = await transcribeAudioFile(audioPath)
      const prompt = `A user recorded audio that transcribed to:
"${transcript || "No speech detected"}"

Give a concise assistant response and suggest useful next actions in plain text.`
      const text = this.useOllama
        ? await this.callOllama(prompt)
        : await this.callGroqTextPrompt(prompt)
      return { text, timestamp: Date.now() }
    } catch (error) {
      console.error("Error analyzing audio file:", error)
      throw error
    }
  }

  public async analyzeAudioFromBase64(data: string, mimeType: string) {
    try {
      const transcript = await transcribeAudioBase64(data, mimeType)
      const prompt = `A user recorded audio that transcribed to:
"${transcript || "No speech detected"}"

Give a concise assistant response and suggest useful next actions in plain text.`
      const text = this.useOllama
        ? await this.callOllama(prompt)
        : await this.callGroqTextPrompt(prompt)
      return { text, timestamp: Date.now() }
    } catch (error) {
      console.error("Error analyzing audio from base64:", error)
      throw error
    }
  }

  public async analyzeImageFile(imagePath: string) {
    try {
      if (this.useOllama) {
        throw new Error("Inline image analysis is not supported in Ollama mode in this app.")
      }

      const stats = await fs.promises.stat(imagePath)
      const maxInlineBytes = 4_000_000
      if (stats.size > maxInlineBytes) {
        throw new Error(
          `[LLMHelper] Refusing to inline image ${imagePath} (${stats.size} bytes); exceeds ${maxInlineBytes} bytes.`
        )
      }

      const imageBase64 = await this.readImageAsBase64(imagePath)
      const prompt =
        "Describe the content of this image briefly and provide useful next-step suggestions. Keep it concise."
      const text = await this.callGroqVisionPrompt(prompt, [imageBase64])
      return { text, timestamp: Date.now() }
    } catch (error) {
      console.error("Error analyzing image file:", error)
      throw error
    }
  }

  public async chatWithGroq(message: string): Promise<string> {
    try {
      if (this.useOllama) {
        return this.callOllama(message)
      }
      return this.callGroqTextPrompt(message)
    } catch (error) {
      console.error("[LLMHelper] Error in chatWithGroq:", error)
      throw error
    }
  }

  // Backward-compatible alias for existing IPC/renderer calls.
  public async chatWithGemini(message: string): Promise<string> {
    return this.chatWithGroq(message)
  }

  public async chat(message: string): Promise<string> {
    return this.chatWithGroq(message)
  }

  public isUsingOllama(): boolean {
    return this.useOllama
  }

  public async getOllamaModels(): Promise<string[]> {
    // API-only mode: local model listing is intentionally disabled.
    return []
  }

  public getCurrentProvider(): "ollama" | "groq" {
    return this.useOllama ? "ollama" : "groq"
  }

  public getCurrentModel(): string {
    return this.useOllama ? this.ollamaModel : this.groqModel
  }

  public async switchToOllama(model?: string, url?: string): Promise<void> {
    throw new Error("Local model mode is disabled. Use cloud API provider.")
  }

  public async switchToGroq(
    apiKey?: string,
    model?: string,
    visionModel?: string
  ): Promise<void> {
    if (apiKey) {
      this.groqApiKey = apiKey
    }
    if (!this.groqApiKey) {
      throw new Error("No Groq API key provided and no existing Groq key configured")
    }

    if (model) {
      this.groqModel = model
    }
    if (visionModel) {
      this.groqVisionModel = visionModel
    }

    this.useOllama = false
    console.log(`[LLMHelper] Switched to Groq (${this.groqModel})`)
  }

  // Backward-compatible alias.
  public async switchToGemini(apiKey?: string): Promise<void> {
    await this.switchToGroq(apiKey)
  }

  public async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      if (this.useOllama) {
        const available = await this.checkOllamaAvailable()
        if (!available) {
          return { success: false, error: `Ollama not available at ${this.ollamaUrl}` }
        }
        await this.callOllama("Hello")
        return { success: true }
      }

      await this.callGroqTextPrompt("Hello")
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  }
}
