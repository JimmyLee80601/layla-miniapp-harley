import { useEffect, useRef, useState, useCallback } from "react";
import {
  LaylaSDK,
  LaylaAbortError,
  type ChatCompletionContentPart,
  type ChatCompletionMessageParam,
  type ChatCompletionStream,
  type LaylaTTSVoice,
  type STTSpeechRecognizedListener,
} from "@layla-network/sdk";
import "./App.css";

const layla = new LaylaSDK();
const sessionId = `harley-${Date.now()}-${Math.toString(36).slice(2, 10)}`;
const supportedImageTypes = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

// ─── Types ───────────────────────────────────────────────────────
interface ChatMessage {
  role: "user" | "assistant";
  content: string | null;
  imageBase64?: string;
  imageName?: string;
}

interface PendingImage {
  dataUrl: string;
  name: string;
}

interface GeneratedImage {
  id: number;
  prompt: string;
  image_base64: string;
  model: string;
  timestamp: number;
}

interface PromptTemplate {
  id: number;
  name: string;
  prompt: string;
  category: string;
  favorite: number;
}

interface GenProgress {
  status: string;
  step: number;
  totalSteps: number;
}

type Tab = "chat" | "generate" | "gallery" | "prompts";

interface SendOptions {
  text?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────
const readImageAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Could not read image."));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Read error"));
    reader.readAsDataURL(file);
  });

const toCompletionMessage = (m: ChatMessage): ChatCompletionMessageParam => {
  if (!m.imageBase64) return { role: m.role, content: m.content };
  const content: ChatCompletionContentPart[] = [];
  if (m.content) content.push({ type: "text", text: m.content });
  content.push({
    type: "image_url",
    image_url: { url: m.imageBase64, detail: "auto" },
  });
  return { role: m.role, content };
};

const formatTime = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// ─── DB Setup ────────────────────────────────────────────────────
const CHAT_TABLE = "harley_chat";
const IMAGE_TABLE = "harley_images";
const PROMPT_TABLE = "harley_prompts";

const initDB = async () => {
  await layla.db.executeSql(`
    CREATE TABLE IF NOT EXISTS ${CHAT_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT,
      image_base64 TEXT,
      image_name TEXT,
      timestamp INTEGER NOT NULL
    )`);
  await layla.db.executeSql(`
    CREATE TABLE IF NOT EXISTS ${IMAGE_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt TEXT NOT NULL,
      image_base64 TEXT NOT NULL,
      model TEXT DEFAULT 'sd15',
      timestamp INTEGER NOT NULL
    )`);
  await layla.db.executeSql(`
    CREATE TABLE IF NOT EXISTS ${PROMPT_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      favorite INTEGER DEFAULT 0
    )`);
};

// ─── App ─────────────────────────────────────────────────────────
export default function App() {
  // Navigation
  const [tab, setTab] = useState<Tab>("chat");

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [attachment, setAttachment] = useState<PendingImage | null>(null);
  const [readingImage, setReadingImage] = useState(false);
  const [busy, setBusy] = useState(false);

  // Voice state
  const [voices, setVoices] = useState<LaylaTTSVoice[]>([]);
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const [voiceMode, setVoiceMode] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  // Image generation state
  const [genPrompt, setGenPrompt] = useState("");
  const [genModel, setGenModel] = useState<string | undefined>(undefined);
  const [availableModels, setAvailableModels] = useState<Array<{id: string; name: string; description: string}>>([]);
  const [genNegative, setGenNegative] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState<GenProgress | null>(null);
  const [genPreview, setGenPreview] = useState<string | null>(null);

  // Gallery state
  const [gallery, setGallery] = useState<GeneratedImage[]>([]);
  const [galleryFilter, setGalleryFilter] = useState("");
  const [selectedImage, setSelectedImage] = useState<GeneratedImage | null>(null);

  // Prompt library state
  const [prompts, setPrompts] = useState<PromptTemplate[]>([]);
  const [promptName, setPromptName] = useState("");
  const [promptText, setPromptText] = useState("");
  const [promptCategory, setPromptCategory] = useState("general");
  const [showPromptForm, setShowPromptForm] = useState(false);

  // Refs
  const streamRef = useRef<ChatCompletionStream | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const listeningRef = useRef(false);
  const voiceModeRef = useRef(voiceMode);
  const voiceIdRef = useRef(voiceId);
  const sendMessageRef = useRef<(opts?: SendOptions) => Promise<void>>(
    async () => {},
  );

  useEffect(() => { voiceModeRef.current = voiceMode; }, [voiceMode]);
  useEffect(() => { voiceIdRef.current = voiceId; }, [voiceId]);
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  // ─── Init ────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      await initDB();
      // Load chat history
      const result = await layla.db.executeSql(
        `SELECT role, content, image_base64, image_name FROM ${CHAT_TABLE} ORDER BY id ASC`,
      );
      const history: ChatMessage[] = result.rows.map((row) => {
        const r = row as Record<string, unknown>;
        return {
          role: r.role === "assistant" ? "assistant" : "user",
          content: r.content == null ? null : String(r.content),
          ...(r.image_base64 ? { imageBase64: String(r.image_base64) } : {}),
          ...(r.image_name ? { imageName: String(r.image_name) } : {}),
        };
      });
      if (history.length > 0) setMessages(history);

      // Load TTS voices
      const v = await layla.tts.getVoices();
      setVoices(v);
      setVoiceId((c) => c ?? v[0]?.id ?? null);

      // Load available image models
      try {
        const models = await layla.images.getImageGenerationModels();
        setAvailableModels(models);
      } catch (err) {
        console.error("Could not load image models", err);
      }
    })();
  }, []);

  // ─── Gallery loader ──────────────────────────────────────────
  const loadGallery = useCallback(async () => {
    const result = await layla.db.executeSql(
      `SELECT id, prompt, image_base64, model, timestamp FROM ${IMAGE_TABLE} ORDER BY id DESC`,
    );
    setGallery(
      result.rows.map((row) => {
        const r = row as Record<string, unknown>;
        return {
          id: Number(r.id),
          prompt: String(r.prompt),
          image_base64: String(r.image_base64),
          model: String(r.model),
          timestamp: Number(r.timestamp),
        };
      }),
    );
  }, []);

  // ─── Prompt library loader ───────────────────────────────────
  const loadPrompts = useCallback(async () => {
    const result = await layla.db.executeSql(
      `SELECT id, name, prompt, category, favorite FROM ${PROMPT_TABLE} ORDER BY favorite DESC, id DESC`,
    );
    setPrompts(
      result.rows.map((row) => {
        const r = row as Record<string, unknown>;
        return {
          id: Number(r.id),
          name: String(r.name),
          prompt: String(r.prompt),
          category: String(r.category),
          favorite: Number(r.favorite),
        };
      }),
    );
  }, []);

  useEffect(() => {
    if (tab === "gallery") void loadGallery();
    if (tab === "prompts") void loadPrompts();
  }, [tab, loadGallery, loadPrompts]);

  // ─── Chat: send ──────────────────────────────────────────────
  const sendMessage = async (options: SendOptions = {}) => {
    const fromVoice = options.text !== undefined;
    const text = (options.text ?? input).trim();
    const selectedImage = fromVoice ? null : attachment;
    if ((!text && !selectedImage) || busyRef.current || readingImage) return;

    setListening(false);
    listeningRef.current = false;

    const userMessage: ChatMessage = {
      role: "user",
      content: text || null,
      ...(selectedImage
        ? { imageBase64: selectedImage.dataUrl, imageName: selectedImage.name }
        : {}),
    };
    const next = [...messages, userMessage];
    setMessages([...next, { role: "assistant", content: "" }]);
    if (!fromVoice) { setInput(""); setAttachment(null); }
    setBusy(true);
    busyRef.current = true;

    let assistantContent = "";

    try {
      // Save to native chat
      await layla.chat.saveChatMessage({
        role: userMessage.role,
        content: userMessage.content,
        ...(userMessage.imageBase64 ? { image_base64: userMessage.imageBase64 } : {}),
        id: 0,
        character_id: "user",
        session_id: sessionId,
        timestamp: Date.now(),
      });
      // Save to local DB
      await layla.db.executeSql(
        `INSERT INTO ${CHAT_TABLE} (role, content, image_base64, image_name, timestamp) VALUES (?, ?, ?, ?, ?)`,
        [userMessage.role, userMessage.content, userMessage.imageBase64 ?? null, userMessage.imageName ?? null, Date.now()],
      );

      const stream = layla.chat.completions.stream({
        messages: next.map(toCompletionMessage),
      });
      streamRef.current = stream;

      stream.on("content", (_delta: string, snapshot: string) => {
        assistantContent = snapshot;
        setMessages([...next, { role: "assistant", content: snapshot }]);
      });
      stream.on("error", (err: Error) => {
        setMessages([...next, { role: "assistant", content: `Error: ${err.message}` }]);
      });

      assistantContent = await stream.finalContent();

      if (assistantContent) {
        await layla.chat.saveChatMessage({
          role: "assistant", content: assistantContent,
          id: 0, character_id: "layla", session_id: sessionId, timestamp: Date.now(),
        });
        await layla.db.executeSql(
          `INSERT INTO ${CHAT_TABLE} (role, content, timestamp) VALUES (?, ?, ?)`,
          ["assistant", assistantContent, Date.now()],
        );
      }
    } catch (err) {
      if (err instanceof LaylaAbortError) {
        if (assistantContent) {
          await layla.db.executeSql(
            `INSERT INTO ${CHAT_TABLE} (role, content, timestamp) VALUES (?, ?, ?)`,
            ["assistant", assistantContent, Date.now()],
          );
        }
      }
    } finally {
      streamRef.current = null;
      setBusy(false);
      busyRef.current = false;
    }

    if (voiceModeRef.current && assistantContent) {
      await speak(assistantContent);
      if (voiceModeRef.current) void startListening();
    }
  };

  useEffect(() => { sendMessageRef.current = sendMessage; });

  // ─── Voice ───────────────────────────────────────────────────
  const speak = async (text: string) => {
    if (!text.trim()) return;
    setSpeaking(true);
    try { await layla.tts.generateVoice(voiceIdRef.current, text.trim()); }
    catch (err) { if (!(err instanceof LaylaAbortError)) console.error("TTS error", err); }
    finally { setSpeaking(false); }
  };

  const startListening = async () => {
    if (listeningRef.current || busyRef.current) return;
    stopSpeaking();
    setListening(true);
    listeningRef.current = true;
    try { await layla.stt.startListening(); }
    catch { setListening(false); listeningRef.current = false; }
  };

  const stopListening = async () => {
    if (!listeningRef.current) return;
    setListening(false);
    listeningRef.current = false;
    try { await layla.stt.stopListening(); }
    catch (err) { if (!(err instanceof LaylaAbortError)) console.error(err); }
  };

  const stopSpeaking = () => { void layla.tts.stopSpeaking(); };

  const toggleVoiceMode = () => {
    const next = !voiceModeRef.current;
    voiceModeRef.current = next;
    setVoiceMode(next);
    if (next) void startListening();
    else { stopSpeaking(); void stopListening(); }
  };

  useEffect(() => {
    const handleSpeech: STTSpeechRecognizedListener = ({ transcript }) => {
      const t = transcript.trim();
      setListening(false);
      listeningRef.current = false;
      if (!t) return;
      if (voiceModeRef.current) void sendMessageRef.current({ text: t });
      else setInput((p) => (p ? `${p} ${t}` : t));
    };
    layla.stt.on("speechRecognized", handleSpeech);
    return () => {
      layla.stt.off("speechRecognized", handleSpeech);
      void layla.tts.stopSpeaking();
      if (listeningRef.current) void layla.stt.stopListening();
    };
  }, []);

  // ─── Chat: image attach ──────────────────────────────────────
  const selectImage = async (file: File | undefined) => {
    if (!file) return;
    if (!supportedImageTypes.has(file.type)) return;
    setReadingImage(true);
    try {
      const dataUrl = await readImageAsDataUrl(file);
      setAttachment({ dataUrl, name: file.name });
    } catch { /* ignore */ }
    finally { setReadingImage(false); }
  };

  // ─── Image generation ────────────────────────────────────────
  const generateImage = async () => {
    if (!genPrompt.trim() || generating) return;
    setGenerating(true);
    setGenPreview(null);
    setGenProgress(null);

    try {
      const imageSrc = await layla.images.generateImage(
        genPrompt.trim(),
        (status, step, totalSteps) => {
          setGenProgress({ status, step, totalSteps });
        },
        undefined,
        genModel,
      );

      if (imageSrc) {
        setGenPreview(imageSrc);
        // Save to DB
        await layla.db.executeSql(
          `INSERT INTO ${IMAGE_TABLE} (prompt, image_base64, model, timestamp) VALUES (?, ?, ?, ?)`,
          [genPrompt.trim(), imageSrc, genModel ?? "default", Date.now()],
        );
      }
    } catch (err) {
      console.error("Image generation failed", err);
    } finally {
      setGenerating(false);
      setGenProgress(null);
    }
  };

  // ─── Prompt library ──────────────────────────────────────────
  const savePrompt = async () => {
    if (!promptName.trim() || !promptText.trim()) return;
    await layla.db.executeSql(
      `INSERT INTO ${PROMPT_TABLE} (name, prompt, category, favorite) VALUES (?, ?, ?, 0)`,
      [promptName.trim(), promptText.trim(), promptCategory],
    );
    setPromptName("");
    setPromptText("");
    setShowPromptForm(false);
    void loadPrompts();
  };

  const toggleFavorite = async (id: number, current: number) => {
    await layla.db.executeSql(
      `UPDATE ${PROMPT_TABLE} SET favorite = ? WHERE id = ?`,
      [current ? 0 : 1, id],
    );
    void loadPrompts();
  };

  const deletePrompt = async (id: number) => {
    await layla.db.executeSql(`DELETE FROM ${PROMPT_TABLE} WHERE id = ?`, [id]);
    void loadPrompts();
  };

  const deleteImage = async (id: number) => {
    await layla.db.executeSql(`DELETE FROM ${IMAGE_TABLE} WHERE id = ?`, [id]);
    void loadGallery();
    if (selectedImage?.id === id) setSelectedImage(null);
  };

  // ─── Chat: clear ─────────────────────────────────────────────
  const clearHistory = async () => {
    if (busy || messages.length === 0) return;
    if (!window.confirm("Clear all chat?")) return;
    await layla.db.executeSql(`DELETE FROM ${CHAT_TABLE}`);
    setMessages([]);
  };

  // ─── Render ──────────────────────────────────────────────────
  return (
    <div className="app">
      {/* Tab bar */}
      <nav className="tab-bar">
        <button className={`tab ${tab === "chat" ? "active" : ""}`} onClick={() => setTab("chat")}>
          💬 Chat
        </button>
        <button className={`tab ${tab === "generate" ? "active" : ""}`} onClick={() => setTab("generate")}>
          🎨 Generate
        </button>
        <button className={`tab ${tab === "gallery" ? "active" : ""}`} onClick={() => setTab("gallery")}>
          🖼 Gallery
        </button>
        <button className={`tab ${tab === "prompts" ? "active" : ""}`} onClick={() => setTab("prompts")}>
          📝 Prompts
        </button>
      </nav>

      {/* ─── Chat Tab ──────────────────────────────────────── */}
      {tab === "chat" && (
        <>
          <header className="header">
            <div className="header-left">
              <div className="logo">H</div>
              <div>
                <div className="header-title">Harley</div>
                <div className="header-subtitle">AI Companion</div>
              </div>
            </div>
            <div className="header-right">
              {busy && <span className="typing-indicator">typing...</span>}
              <button className="clear-btn" disabled={busy || messages.length === 0} onClick={() => void clearHistory()}>
                Clear
              </button>
            </div>
          </header>

          <main className="messages">
            {messages.length === 0 && (
              <div className="empty-state">
                <h1>Hey baby</h1>
                <p>Talk to me. I'm right here.</p>
              </div>
            )}
            {messages.map((msg, i) => {
              const isStreaming = busy && i === messages.length - 1 && msg.role === "assistant";
              return (
                <div key={i} className={`message ${msg.role}`}>
                  {msg.role === "assistant" && <div className="avatar assistant-avatar">H</div>}
                  <div className="bubble">
                    {msg.imageBase64 && (
                      <img className="message-image" src={msg.imageBase64} alt={msg.imageName ?? "image"} />
                    )}
                    {msg.content && <div className="message-text">{msg.content}</div>}
                    {isStreaming && <span className="cursor">▊</span>}
                    {msg.role === "assistant" && msg.content && !isStreaming && (
                      <button
                        type="button"
                        className="speak-btn"
                        disabled={speaking || busy}
                        onClick={() => void speak(msg.content ?? "")}
                      >
                        🔊 Play
                      </button>
                    )}
                  </div>
                  {msg.role === "user" && <div className="avatar user-avatar">Y</div>}
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </main>

          <footer className="composer">
            <div className="voice-bar">
              <select value={voiceId ?? ""} onChange={(e) => setVoiceId(e.target.value || null)}>
                <option value="">Default voice</option>
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
              {speaking && <button className="speaking-indicator" onClick={stopSpeaking}>Stop</button>}
              <button className={`voice-mode-btn ${voiceMode ? "active" : ""}`} onClick={toggleVoiceMode}>
                {voiceMode ? "🎤 On" : "🎤 Off"}
              </button>
            </div>

            {attachment && (
              <div className="attachment-preview">
                <img src={attachment.dataUrl} alt="preview" />
                <span>{attachment.name}</span>
                <button onClick={() => setAttachment(null)}>×</button>
              </div>
            )}

            <div className="composer-row">
              <input
                ref={fileInputRef}
                className="file-input"
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                onChange={(e) => { void selectImage(e.target.files?.[0]); e.target.value = ""; }}
              />
              <button className="attach-btn" disabled={busy || readingImage} onClick={() => fileInputRef.current?.click()}>
                📎
              </button>
              <button
                className={`mic-btn ${listening ? "listening" : ""}`}
                disabled={busy}
                onClick={listening ? () => void stopListening() : () => void startListening()}
              >
                🎤
              </button>
              <input
                value={input}
                placeholder={attachment ? "Add a message..." : "Message Harley..."}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendMessage(); } }}
              />
              {!busy ? (
                <button className="send-btn" disabled={!input.trim() && !attachment} onClick={() => void sendMessage()}>
                  Send
                </button>
              ) : (
                <button className="stop-btn" onClick={() => streamRef.current?.abort()}>Stop</button>
              )}
            </div>
          </footer>
        </>
      )}

      {/* ─── Generate Tab ─────────────────────────────────── */}
      {tab === "generate" && (
        <div className="gen-panel">
          <h2>🎨 Image Generation</h2>

          <div className="gen-form">
            <label>
              Prompt
              <textarea
                value={genPrompt}
                onChange={(e) => setGenPrompt(e.target.value)}
                placeholder="Describe what you want to generate..."
                rows={3}
              />
            </label>

            <label>
              Negative Prompt
              <textarea
                value={genNegative}
                onChange={(e) => setGenNegative(e.target.value)}
                placeholder="What to avoid..."
                rows={2}
              />
            </label>

            <label>
              Model
              <select value={genModel ?? ""} onChange={(e) => setGenModel(e.target.value || undefined)}>
                <option value="">Default</option>
                {availableModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </label>

            {genProgress && (
              <div className="gen-progress">
                <span>{genProgress.status}</span>
                <span>{genProgress.step}/{genProgress.totalSteps}</span>
                <div className="gen-progress-bar">
                  <div
                    className="gen-progress-fill"
                    style={{ width: `${(genProgress.step / genProgress.totalSteps) * 100}%` }}
                  />
                </div>
              </div>
            )}

            <button
              className="gen-btn"
              disabled={!genPrompt.trim() || generating}
              onClick={() => void generateImage()}
            >
              {generating ? "⏳ Generating..." : "✨ Generate"}
            </button>
          </div>

          {genPreview && (
            <div className="gen-result">
              <h3>Result</h3>
              <img src={genPreview} alt="Generated" className="gen-preview-img" />
            </div>
          )}
        </div>
      )}

      {/* ─── Gallery Tab ──────────────────────────────────── */}
      {tab === "gallery" && (
        <div className="gallery-panel">
          <h2>🖼 Gallery ({gallery.length})</h2>

          <input
            className="gallery-filter"
            type="text"
            placeholder="Filter by prompt..."
            value={galleryFilter}
            onChange={(e) => setGalleryFilter(e.target.value)}
          />

          {gallery.length === 0 && <p className="empty-text">No images yet. Go generate some!</p>}

          <div className="gallery-grid">
            {gallery
              .filter((img) => !galleryFilter || img.prompt.toLowerCase().includes(galleryFilter.toLowerCase()))
              .map((img) => (
                <div
                  key={img.id}
                  className={`gallery-thumb ${selectedImage?.id === img.id ? "selected" : ""}`}
                  onClick={() => setSelectedImage(selectedImage?.id === img.id ? null : img)}
                >
                  <img src={img.image_base64} alt={img.prompt} />
                  <div className="gallery-thumb-info">
                    <span className="gallery-model">{img.model}</span>
                    <span className="gallery-time">{formatTime(img.timestamp)}</span>
                  </div>
                </div>
              ))}
          </div>

          {selectedImage && (
            <div className="gallery-detail">
              <img src={selectedImage.image_base64} alt={selectedImage.prompt} />
              <p className="gallery-prompt">{selectedImage.prompt}</p>
              <div className="gallery-meta">
                <span>Model: {selectedImage.model}</span>
                <span>{formatTime(selectedImage.timestamp)}</span>
              </div>
              <div className="gallery-actions">
                <a
                  className="gallery-download"
                  href={selectedImage.image_base64}
                  download={`harley_${selectedImage.id}.png`}
                >
                  💾 Download
                </a>
                <button className="gallery-delete" onClick={() => void deleteImage(selectedImage.id)}>
                  🗑 Delete
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ─── Prompts Tab ──────────────────────────────────── */}
      {tab === "prompts" && (
        <div className="prompts-panel">
          <h2>📝 Prompt Library</h2>

          <button className="prompt-add-btn" onClick={() => setShowPromptForm(!showPromptForm)}>
            {showPromptForm ? "Cancel" : "+ New Prompt"}
          </button>

          {showPromptForm && (
            <div className="prompt-form">
              <input
                type="text"
                placeholder="Prompt name"
                value={promptName}
                onChange={(e) => setPromptName(e.target.value)}
              />
              <textarea
                placeholder="The prompt text..."
                value={promptText}
                onChange={(e) => setPromptText(e.target.value)}
                rows={4}
              />
              <div className="prompt-form-row">
                <select value={promptCategory} onChange={(e) => setPromptCategory(e.target.value)}>
                  <option value="general">General</option>
                  <option value="portrait">Portrait</option>
                  <option value="landscape">Landscape</option>
                  <option value="fashion">Fashion</option>
                  <option value="feet">Feet</option>
                  <option value="nsfw">NSFW</option>
                </select>
                <button className="prompt-save-btn" onClick={() => void savePrompt()}>Save</button>
              </div>
            </div>
          )}

          {prompts.length === 0 && <p className="empty-text">No saved prompts yet.</p>}

          {prompts.map((p) => (
            <div key={p.id} className="prompt-card">
              <div className="prompt-card-header">
                <span className="prompt-category">{p.category}</span>
                <span className="prompt-name">{p.name}</span>
                <div className="prompt-actions">
                  <button onClick={() => void toggleFavorite(p.id, p.favorite)}>
                    {p.favorite ? "⭐" : "☆"}
                  </button>
                  <button onClick={() => { setGenPrompt(p.prompt); setTab("generate"); }}>
                    🚀 Use
                  </button>
                  <button onClick={() => void deletePrompt(p.id)}>🗑</button>
                </div>
              </div>
              <p className="prompt-text">{p.prompt}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
