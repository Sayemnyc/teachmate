/*
 * TeachMate — frontend
 * --------------------------------------------------------------------
 * Single-file SPA logic. Deliberately framework-free so the whole thing
 * stays small and readable, and so the app can be served from any
 * static host (or from FastAPI's StaticFiles mount, as we do here).
 *
 * Main responsibilities:
 *   1. Session bootstrap (stable id in localStorage)
 *   2. Streaming SSE parser for /api/chat, /api/explain-simple, /api/summarize
 *   3. Image upload → base64 → piggyback on the next chat message
 *   4. Health check that drives the offline-status badge
 */

(() => {
  "use strict";

  // ---- DOM handles ----------------------------------------------------
  const $subject      = document.getElementById("subject");
  const $status       = document.getElementById("status");
  const $statusText   = $status.querySelector(".status-text");
  const $messages     = document.getElementById("messages");
  const $composer     = document.getElementById("composer");
  const $input        = document.getElementById("input");
  const $send         = document.getElementById("btn-send");
  const $upload       = document.getElementById("btn-upload");
  const $fileInput    = document.getElementById("file-input");
  const $explain      = document.getElementById("btn-explain");
  const $summarize    = document.getElementById("btn-summarize");
  const $new          = document.getElementById("btn-new");
  const $attach       = document.getElementById("attachment-preview");
  const $attachThumb  = document.getElementById("attachment-thumb");
  const $attachName   = document.getElementById("attachment-name");
  const $attachRemove = document.getElementById("attachment-remove");

  // ---- Session / attachment state ------------------------------------

  // Stable id so refreshing the page keeps the server-side conversation.
  // The browser-generated UUID is good enough — no auth or multi-user.
  const SESSION_KEY = "tm_session";
  const SUBJECT_KEY = "tm_subject";

  let sessionId = localStorage.getItem(SESSION_KEY);
  if (!sessionId) {
    sessionId = (crypto.randomUUID && crypto.randomUUID()) ||
                `s_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(SESSION_KEY, sessionId);
  }

  const storedSubject = localStorage.getItem(SUBJECT_KEY);
  if (storedSubject) $subject.value = storedSubject;

  $subject.addEventListener("change", () => {
    localStorage.setItem(SUBJECT_KEY, $subject.value);
  });

  // Pending image attachment (base64, no data-URL prefix) that will ride
  // along with the next sent message.
  let pendingImage = null;      // string (base64) | null
  let pendingImageDataUrl = null; // full data URL for preview
  let pendingImageName = "";

  // Streaming lock — avoids overlapping requests that would interleave
  // tokens into the same bubble.
  let busy = false;

  // ---- Health check ---------------------------------------------------

  async function checkHealth() {
    try {
      const r = await fetch("/api/health");
      const j = await r.json();
      if (j.ollama_up && j.model_available) {
        setStatus("ok", "🟢 Running Locally — No Internet Needed");
      } else if (j.ollama_up && !j.model_available) {
        setStatus(
          "error",
          `Model ${j.model} not found. Run: ollama pull ${j.model}`
        );
      } else {
        setStatus("error", "Ollama not running. Try: ollama serve");
      }
    } catch {
      setStatus("error", "Can't reach the server.");
    }
  }

  function setStatus(kind, message) {
    $status.classList.remove("status--checking", "status--error");
    if (kind === "error") $status.classList.add("status--error");
    $statusText.textContent = message;
    $status.title = message;
  }

  // ---- Empty-state greeting ------------------------------------------

  function renderGreeting() {
    const subject = $subject.value;
    const suggestions = SUGGESTIONS[subject] || [];
    const html = `
      <div class="greeting">
        <h2>Hi! I'm TeachMate. 👋</h2>
        <p>
          Pick any question you're stuck on and I'll help you think it
          through — step by step. You can also snap a photo of your homework.
        </p>
        <div class="chip-row">
          ${suggestions.map(s => `<button class="chip" data-prompt="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join("")}
        </div>
      </div>
    `;
    $messages.insertAdjacentHTML("beforeend", html);
    $messages.querySelectorAll(".chip").forEach(chip => {
      chip.addEventListener("click", () => {
        $input.value = chip.dataset.prompt;
        $input.focus();
        autoSizeTextarea();
      });
    });
  }

  // Subject-tailored example prompts that seed the empty state.
  const SUGGESTIONS = {
    Math:      ["Help me solve 2x + 3 = 11", "What is a fraction?", "How do I find the area of a triangle?"],
    Science:   ["Why is the sky blue?", "How do plants make food?", "What is gravity?"],
    History:   ["Why did World War I start?", "Who was Cleopatra?", "What was the Silk Road?"],
    English:   ["What is a metaphor?", "Help me write a topic sentence", "Explain the difference between 'affect' and 'effect'"],
    Geography: ["What causes earthquakes?", "Why do deserts form?", "Name the layers of the atmosphere"],
  };

  // ---- Message rendering ---------------------------------------------

  function addUserBubble(text, imageDataUrl) {
    clearGreeting();
    const bubble = document.createElement("div");
    bubble.className = "bubble bubble--user";
    if (imageDataUrl) {
      const img = document.createElement("img");
      img.className = "attached";
      img.src = imageDataUrl;
      img.alt = "Attached homework";
      bubble.appendChild(img);
    }
    if (text) {
      const p = document.createElement("div");
      p.textContent = text;
      bubble.appendChild(p);
    }
    $messages.appendChild(bubble);
    scrollToBottom();
  }

  /** Create a tutor bubble and return helpers to append streamed text. */
  function addTutorBubble() {
    clearGreeting();
    const bubble = document.createElement("div");
    bubble.className = "bubble bubble--tutor";
    const thinking = document.createElement("div");
    thinking.className = "thinking";
    thinking.innerHTML = "<span></span><span></span><span></span>";
    bubble.appendChild(thinking);
    $messages.appendChild(bubble);
    scrollToBottom();

    let text = "";
    let finalized = false;
    return {
      append(token) {
        if (!finalized && thinking.parentNode === bubble) {
          bubble.removeChild(thinking);
        }
        text += token;
        bubble.textContent = text;
        scrollToBottom();
      },
      finalize() {
        finalized = true;
        if (thinking.parentNode === bubble) bubble.removeChild(thinking);
        if (!text) bubble.textContent = "(no response)";
      },
      error(msg) {
        if (thinking.parentNode === bubble) bubble.removeChild(thinking);
        bubble.className = "bubble bubble--error";
        bubble.textContent = msg;
      },
    };
  }

  function addSystemNote(text) {
    const note = document.createElement("div");
    note.className = "bubble bubble--system";
    note.textContent = text;
    $messages.appendChild(note);
    scrollToBottom();
  }

  function clearGreeting() {
    const g = $messages.querySelector(".greeting");
    if (g) g.remove();
  }

  function scrollToBottom() {
    // requestAnimationFrame avoids scroll jank when many tokens arrive
    // back-to-back during fast streaming.
    requestAnimationFrame(() => {
      $messages.scrollTop = $messages.scrollHeight;
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    }[c]));
  }

  // ---- SSE streaming --------------------------------------------------

  /**
   * POST to an SSE endpoint and drive the callbacks as tokens arrive.
   * Parses Ollama's SSE frames (`data: {...}\n\n`) and tolerates partial
   * reads that split a frame across chunk boundaries.
   */
  async function streamPost(url, body, { onToken, onDone, onError }) {
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      onError(`Network error: ${e.message || e}`);
      return;
    }

    if (!response.ok) {
      let msg = `Request failed (${response.status})`;
      try {
        const j = await response.json();
        if (j.detail) msg = j.detail;
      } catch { /* ignore */ }
      onError(msg);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        onError(`Stream error: ${e.message || e}`);
        return;
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      // Frames are delimited by blank lines; split and keep any
      // trailing partial frame in the buffer for the next iteration.
      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        // Each frame may have multiple `data: ...` lines. Ollama's SSE
        // output only uses one per frame, but we handle the general case.
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let obj;
          try { obj = JSON.parse(payload); } catch { continue; }
          if (obj.error)   { onError(obj.error); return; }
          if (obj.token)   { onToken(obj.token); }
          if (obj.done)    { onDone(); return; }
        }
      }
    }
    // Stream closed without an explicit `done` — treat as complete.
    onDone();
  }

  // ---- Actions --------------------------------------------------------

  async function sendMessage() {
    if (busy) return;
    const text = $input.value.trim();
    if (!text && !pendingImage) return;

    const subject = $subject.value;
    const imageToSend = pendingImage;
    const imageDataUrl = pendingImageDataUrl;

    addUserBubble(text, imageDataUrl);
    $input.value = "";
    autoSizeTextarea();
    clearAttachment();

    await runStream("/api/chat", {
      session_id: sessionId,
      subject,
      message: text,
      image_base64: imageToSend || undefined,
    });
  }

  async function explainSimple() {
    if (busy) return;
    addSystemNote("Re-explaining in simpler words…");
    await runStream("/api/explain-simple", { session_id: sessionId });
  }

  async function summarize() {
    if (busy) return;
    addSystemNote("Summarizing what you've learned…");
    await runStream("/api/summarize", { session_id: sessionId });
  }

  async function newChat() {
    if (busy) return;
    try {
      await fetch("/api/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      });
    } catch { /* non-fatal — server-side state is in-memory anyway */ }
    $messages.innerHTML = "";
    renderGreeting();
    $input.focus();
  }

  /** Shared stream driver: creates a tutor bubble and hooks up callbacks. */
  async function runStream(url, body) {
    setBusy(true);
    const bubble = addTutorBubble();
    await streamPost(url, body, {
      onToken: t  => bubble.append(t),
      onDone:  () => { bubble.finalize(); setBusy(false); },
      onError: e  => { bubble.error(e); setBusy(false); },
    });
  }

  function setBusy(v) {
    busy = v;
    $send.disabled = v;
    $upload.disabled = v;
    $explain.disabled = v;
    $summarize.disabled = v;
    $new.disabled = v;
  }

  // ---- Attachment handling -------------------------------------------

  $upload.addEventListener("click", () => $fileInput.click());

  $fileInput.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    // Reset the input so picking the same file again re-triggers change.
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      alert("Please choose an image file.");
      return;
    }
    // Keep a sane cap — very large photos can blow past Ollama's request limit.
    const MAX_BYTES = 6 * 1024 * 1024;
    if (file.size > MAX_BYTES) {
      alert("Image is too large. Please choose one under 6 MB.");
      return;
    }

    const dataUrl = await readAsDataURL(file);
    pendingImageDataUrl = dataUrl;
    // Strip the "data:image/png;base64," prefix — Ollama wants raw base64.
    pendingImage = dataUrl.includes(",") ? dataUrl.split(",", 2)[1] : dataUrl;
    pendingImageName = file.name;

    $attachThumb.src = dataUrl;
    $attachName.textContent = file.name;
    $attach.hidden = false;
    $input.focus();
  });

  $attachRemove.addEventListener("click", clearAttachment);

  function clearAttachment() {
    pendingImage = null;
    pendingImageDataUrl = null;
    pendingImageName = "";
    $attach.hidden = true;
    $attachThumb.removeAttribute("src");
  }

  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  // ---- Composer wiring -----------------------------------------------

  $composer.addEventListener("submit", (e) => {
    e.preventDefault();
    sendMessage();
  });

  // Enter sends, Shift+Enter adds a newline. Matches the UX of most
  // modern chat apps (Claude, WhatsApp web, etc.).
  $input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  $input.addEventListener("input", autoSizeTextarea);

  function autoSizeTextarea() {
    $input.style.height = "auto";
    $input.style.height = Math.min($input.scrollHeight, 200) + "px";
  }

  $explain.addEventListener("click", explainSimple);
  $summarize.addEventListener("click", summarize);
  $new.addEventListener("click", newChat);

  // ---- Boot -----------------------------------------------------------

  renderGreeting();
  checkHealth();
  // Re-check periodically so a late `ollama serve` flips the badge green
  // without requiring a full page reload.
  setInterval(checkHealth, 30_000);
  $input.focus();
})();
