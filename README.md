# TeachMate 📘💡

**An offline-first AI tutor for every classroom.**

TeachMate is a locally-hosted web app that turns any laptop into a patient,
encouraging AI tutor, powered by Google DeepMind's **Gemma 4** running on
**Ollama**. Once installed, it needs **zero internet** to work. That makes it
usable in rural schools, on field trips, in libraries with flaky Wi-Fi, or
anywhere a student wants a private, always-available study partner.

Built for the **[Gemma 4 Good Hackathon](https://www.kaggle.com/competitions/gemma-4-good-hackathon)**
(Future of Education track).

> 🎥 Demo video: https://youtu.be/7CgSdSR074U
>
> 📝 Writeup: WRITEUP.md
>
> 📄 License: Apache 2.0 (see LICENSE)

## 🚀 Quick Start

**One-line install (macOS / Linux):**

```bash
curl -fsSL https://raw.githubusercontent.com/Sayemnyc/teachmate/main/bootstrap.sh | bash
```

This installs Ollama, pulls the 9.6 GB Gemma 4 model, clones the repo into `~/teachmate`, and installs Python dependencies. Python 3.10+ is the only thing you need in advance.

When it finishes, run:

```bash
cd ~/teachmate && uvicorn main:app --reload
```

Then open http://localhost:8000. The status badge turns green when it's ready.

> 🔒 **Want to review the script first?** Run `curl -fsSL https://raw.githubusercontent.com/Sayemnyc/teachmate/main/bootstrap.sh | less` to read it, or open [bootstrap.sh](bootstrap.sh) on GitHub.

**Manual install (Windows, or if you'd rather do it yourself):** see Prerequisites below.

---

## Features

- 📚 **Subject-aware tutoring**: pick Math, Science, History, English, or
  Geography and the tutor adapts its teaching style.
- 🧭 **Socratic guidance**: the tutor guides you toward the answer with
  questions and hints instead of handing you a solution.
- 📷 **Homework photo help**: snap a photo of a problem and get a
  step-by-step walkthrough. (Uses Gemma 4's vision capability.)
- 🧸 **Explain Like I'm 10**: one click re-explains the last response in
  the simplest possible words, with a friendly analogy.
- 📝 **Session summaries**: turn a tutoring conversation into clean
  study notes.
- 🟢 **100% offline**: your questions, your photos, and your thinking
  never leave your device.
- ⚡ **Token-by-token streaming**: answers feel alive and fast.

---

## Prerequisites

1. **Install Ollama** from https://ollama.com/download
2. **Pull the Gemma 4 model** (≈9.6 GB, one-time):
   ```bash
   ollama pull gemma4:e4b
   ```
3. **Python 3.10+**

That's it. Once the model is pulled, you can unplug from the internet.

---

## Install & run

```bash
cd teachmate
pip install -r requirements.txt
uvicorn main:app --reload
```

Then open **http://localhost:8000** in your browser.

The status badge in the top right will turn green when Ollama is reachable
and the model is loaded. If it's red, the message will tell you exactly
what to fix.

---

## How it works

```
┌─────────────────────┐
│  Browser (SPA)      │  HTML/CSS/JS, no frameworks
│  - SSE streaming    │
│  - Image picker     │
└──────────┬──────────┘
           │ fetch (SSE)
┌──────────▼──────────┐
│  FastAPI backend    │  main.py
│  - /api/chat        │
│  - /api/explain-    │
│    simple           │
│  - /api/summarize   │
│  - /api/health      │
└──────────┬──────────┘
           │ HTTP, NDJSON stream
┌──────────▼──────────┐
│  Ollama (local)     │  localhost:11434
│  └─ gemma4:e4b       │  text + vision
└─────────────────────┘
```

- FastAPI forwards Ollama's NDJSON chunks as Server-Sent Events.
- The browser parses the SSE frames with `ReadableStream` + `TextDecoder`
  and appends each token to the current tutor bubble.
- Images are read as base64 in the browser and attached to the user
  message via Ollama's `images` field (Gemma 4 is multimodal).
- Session history is held in memory on the server, keyed by a UUID the
  browser stores in `localStorage`. Restarting the server resets state:
  by design, nothing is persisted.

---

## Project structure

```
teachmate/
├── main.py              # FastAPI app: streaming, sessions, Ollama glue
├── requirements.txt     # Python dependencies
├── static/
│   ├── index.html       # SPA shell
│   ├── style.css        # Warm, mobile-responsive UI
│   └── app.js           # Session, SSE parser, image upload, actions
├── README.md            # This file
├── WRITEUP.md           # Kaggle submission writeup
└── LICENSE              # Apache 2.0
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Badge stays red, "Ollama not running" | Run `ollama serve` in another terminal. |
| Badge says "Model not found" | Run `ollama pull gemma4:e4b`. |
| Image upload fails | Check you pulled the multimodal variant (`e4b`), not a text-only model. |
| Port 8000 already in use | Run `uvicorn main:app --reload --port 8080` and open `http://localhost:8080`. |
| First response is very slow | Ollama lazy-loads the model on first request. Subsequent replies are fast. |

---

## Roadmap

- Voice input for students who prefer to speak their questions.
- Exportable PDF "homework helper" worksheets built from session summaries.
- Multi-turn image reasoning (follow-up questions about the same photo).
- Teacher-dashboard variant that lets a single server serve a classroom.
- Android wrapper via Termux + Ollama using the e2b model.

---

## License

Apache License 2.0. See LICENSE.

---

## Credits

Built by Sayem Islam for the **Gemma 4 Good Hackathon** hosted by
Google DeepMind on Kaggle. Powered by **Gemma 4**, served locally via
**[Ollama](https://ollama.com)**.

Inspired by the 258 million children worldwide who still lack access to
quality education, and by the belief that great tutoring shouldn't
require a data plan.
