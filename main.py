"""
TeachMate: Offline-First AI Tutor
==================================

FastAPI backend that streams responses from a locally-running Ollama
instance serving Gemma 4 (`gemma4:e4b`). The app is designed to run
entirely on-device: once Ollama is installed and the model is pulled,
no internet connection is required.

The backend forwards Ollama's NDJSON streaming output to the browser as
Server-Sent Events (SSE), which lets the UI render answers token-by-token.
Multimodal input (photos of homework) is supported by forwarding
base64-encoded images to Ollama's `/api/chat` endpoint.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import AsyncIterator, Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

OLLAMA_URL = "http://localhost:11434"
MODEL = "gemma4:e4b"

# Socratic tutor persona. Kept verbatim from the product spec. It's the
# single most important piece of prompt-engineering in the app, since it
# defines the "guide, don't give away" pedagogy that makes TeachMate useful
# instead of a homework-cheating shortcut.
BASE_SYSTEM_PROMPT = (
    "You are TeachMate, a warm, patient, and encouraging AI tutor for "
    "school students. Your job is NOT to give direct answers, but to "
    "guide students toward understanding through questions, hints, and "
    "step-by-step explanations. Always be positive and never make the "
    "student feel bad for not knowing something. Adapt your language to "
    "be age-appropriate (assume ages 10-16). When a student uploads an "
    "image of a problem, help them work through it step by step. "
    "Current subject: {subject}."
)

# Subject-specific flavor appended to the base persona. Keeps the model
# anchored in the relevant mode of thinking (e.g. arithmetic breakdowns
# for Math, primary-source reasoning for History).
SUBJECT_FLAVORS: dict[str, str] = {
    "Math": (
        " Focus on breaking problems into small steps, naming each "
        "operation, and checking units. Encourage estimation before "
        "calculation."
    ),
    "Science": (
        " Use concrete analogies and everyday examples. Encourage the "
        "scientific method: observe, hypothesize, test, conclude."
    ),
    "History": (
        " Tie events to cause-and-effect chains, encourage comparing "
        "primary and secondary sources, and ask the student what they "
        "think a person at the time might have felt."
    ),
    "English": (
        " Focus on reading comprehension, vocabulary in context, and "
        "clear writing. Ask the student to rephrase ideas in their own "
        "words."
    ),
    "Geography": (
        " Connect physical features, climate, and human activity. Ask "
        "the student to picture the place and describe it before "
        "answering."
    ),
}

ALLOWED_SUBJECTS = set(SUBJECT_FLAVORS.keys())


# ---------------------------------------------------------------------------
# Session store (in-memory by design; spec calls for no persistence)
# ---------------------------------------------------------------------------

# A session holds the subject and the full message history in the
# OpenAI-style `{role, content, images?}` shape that Ollama's chat API
# accepts directly. Restarting the server wipes history, which is the
# documented behavior.
sessions: dict[str, dict] = {}


def build_system_prompt(subject: str) -> str:
    """Return the full system prompt for a given subject."""
    flavor = SUBJECT_FLAVORS.get(subject, "")
    return BASE_SYSTEM_PROMPT.format(subject=subject) + flavor


def get_or_create_session(session_id: str, subject: str) -> dict:
    """
    Fetch a session or initialize a fresh one. If the subject changed
    since the last turn, we refresh the leading system message so the
    persona matches. This is why the system prompt is always index 0.
    """
    session = sessions.get(session_id)
    if session is None:
        session = {
            "subject": subject,
            "messages": [
                {"role": "system", "content": build_system_prompt(subject)}
            ],
        }
        sessions[session_id] = session
        return session

    if session["subject"] != subject:
        session["subject"] = subject
        # Replace (not append) the system message so we don't accumulate
        # conflicting personas across subject switches.
        session["messages"][0] = {
            "role": "system",
            "content": build_system_prompt(subject),
        }
    return session


# ---------------------------------------------------------------------------
# Request/response models
# ---------------------------------------------------------------------------


class ChatRequest(BaseModel):
    session_id: str = Field(..., min_length=1)
    subject: str
    message: str = ""
    # Image is base64 (no data-URL prefix). Optional, for multimodal homework help.
    image_base64: Optional[str] = None


class SessionRequest(BaseModel):
    session_id: str = Field(..., min_length=1)


# ---------------------------------------------------------------------------
# Ollama streaming helper
# ---------------------------------------------------------------------------


async def stream_ollama_chat(
    messages: list[dict],
    history_session: Optional[dict] = None,
) -> AsyncIterator[bytes]:
    """
    Call Ollama's `/api/chat` with streaming enabled and re-emit each
    token as a Server-Sent Events frame.

    If `history_session` is provided, the full assistant response is
    appended to that session's message history once the stream finishes.
    Meta-actions ("Explain Like I'm 10", "Summarize") pass None so they
    don't pollute the main conversation.
    """
    payload = {
        "model": MODEL,
        "messages": messages,
        "stream": True,
    }

    # httpx timeout=None is intentional: generation can legitimately take
    # minutes on modest hardware, and the SSE stream keeps the connection
    # alive with tokens. We rely on the client disconnect to abort.
    accumulated: list[str] = []
    try:
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream(
                "POST", f"{OLLAMA_URL}/api/chat", json=payload
            ) as response:
                if response.status_code != 200:
                    body = (await response.aread()).decode("utf-8", errors="replace")
                    err = f"Ollama returned {response.status_code}: {body[:500]}"
                    yield _sse({"error": err})
                    return

                async for line in response.aiter_lines():
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        # Ollama only emits one JSON object per line, but
                        # be defensive against partial frames during
                        # unusual network/proxy setups.
                        continue

                    token = obj.get("message", {}).get("content", "")
                    if token:
                        accumulated.append(token)
                        yield _sse({"token": token})

                    if obj.get("done"):
                        # Persist the final assistant message before the
                        # frontend hears "done" so a rapid follow-up
                        # question sees a consistent history.
                        if history_session is not None:
                            history_session["messages"].append(
                                {"role": "assistant", "content": "".join(accumulated)}
                            )
                        yield _sse({"done": True})
                        return

    except httpx.ConnectError:
        yield _sse(
            {
                "error": (
                    "Couldn't reach Ollama at "
                    f"{OLLAMA_URL}. Is it running? Try `ollama serve`."
                )
            }
        )
    except Exception as exc:  # noqa: BLE001
        yield _sse({"error": f"Unexpected error: {exc}"})


def _sse(obj: dict) -> bytes:
    """Encode a dict as an SSE frame."""
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n".encode("utf-8")


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="TeachMate", version="1.0.0")


@app.get("/api/health")
async def health() -> JSONResponse:
    """
    Ping Ollama to drive the UI's "🟢 Running Locally" badge. We also
    report whether the target model is installed so the user gets a
    useful error up front instead of a cryptic failure on first message.
    """
    ollama_up = False
    model_available = False
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get(f"{OLLAMA_URL}/api/tags")
            if r.status_code == 200:
                ollama_up = True
                tags = r.json().get("models", [])
                # We need the *exact* model tag the app targets. Matching
                # on just the base name ("gemma4") would wrongly green-light
                # a user who only has an incompatible variant installed
                # (e.g. a larger tag that won't fit the offline use case).
                installed_names = {m.get("name", "") for m in tags}
                model_available = (
                    MODEL in installed_names
                    or f"{MODEL}:latest" in installed_names
                    or any(
                        name.startswith(f"{MODEL}-") for name in installed_names
                    )
                )
    except Exception:  # noqa: BLE001
        pass
    return JSONResponse(
        {
            "ollama_up": ollama_up,
            "model_available": model_available,
            "model": MODEL,
        }
    )


@app.post("/api/chat")
async def chat(req: ChatRequest) -> StreamingResponse:
    """
    Main chat endpoint. Appends the user turn to session history (with
    an optional image) and streams the tutor's response back as SSE.
    """
    if req.subject not in ALLOWED_SUBJECTS:
        raise HTTPException(status_code=400, detail=f"Unknown subject: {req.subject}")
    if not req.message and not req.image_base64:
        raise HTTPException(status_code=400, detail="Message or image required.")

    session = get_or_create_session(req.session_id, req.subject)

    user_msg: dict = {
        "role": "user",
        # When the user uploads an image without typing, seed a sensible
        # default prompt so the model knows what to do with the image.
        "content": req.message or "Please help me understand this problem.",
    }
    if req.image_base64:
        # Ollama's chat API expects a list of base64 strings (no data-URL
        # prefix). The frontend strips the prefix before sending.
        user_msg["images"] = [req.image_base64]

    session["messages"].append(user_msg)

    return StreamingResponse(
        stream_ollama_chat(session["messages"], history_session=session),
        media_type="text/event-stream",
    )


@app.post("/api/explain-simple")
async def explain_simple(req: SessionRequest) -> StreamingResponse:
    """
    Re-explain the last tutor response using the simplest possible
    language. This is a one-shot meta-action, so we don't want to pollute
    the real conversation with the "pretend I'm 10" reframe, so we
    build a throwaway message list and don't persist the response.
    """
    session = sessions.get(req.session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="No session yet.")

    last_tutor = next(
        (m for m in reversed(session["messages"]) if m["role"] == "assistant"),
        None,
    )
    if last_tutor is None:
        raise HTTPException(
            status_code=400, detail="No tutor response yet to re-explain."
        )

    messages = [
        {
            "role": "system",
            "content": (
                "You re-explain tutoring responses so a 10-year-old can "
                "understand them. Use very short sentences, simple words, "
                "and one friendly real-world analogy. Keep it warm and "
                "encouraging."
            ),
        },
        {
            "role": "user",
            "content": (
                "Please re-explain the following response so a "
                "10-year-old could understand it:\n\n"
                f"{last_tutor['content']}"
            ),
        },
    ]
    return StreamingResponse(
        stream_ollama_chat(messages),
        media_type="text/event-stream",
    )


@app.post("/api/summarize")
async def summarize(req: SessionRequest) -> StreamingResponse:
    """
    Produce a bullet-point summary of what the student learned this
    session. Great for end-of-study notes. Like explain-simple, this
    does not mutate the session history.
    """
    session = sessions.get(req.session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="No session yet.")

    # Flatten the transcript (skip the system prompt and any image
    # payloads, since the model only needs the text to summarize).
    transcript_lines: list[str] = []
    for msg in session["messages"]:
        if msg["role"] == "system":
            continue
        speaker = "Student" if msg["role"] == "user" else "Tutor"
        content = msg.get("content", "")
        if msg.get("images"):
            content = f"[uploaded a photo] {content}".strip()
        transcript_lines.append(f"{speaker}: {content}")
    transcript = "\n".join(transcript_lines) or "(no conversation yet)"

    messages = [
        {
            "role": "system",
            "content": (
                "You summarize tutoring sessions into clear, concise "
                "study notes. Use 4-8 bullet points covering the key "
                "concepts, examples, and takeaways. Start with a "
                "one-line summary of the topic."
            ),
        },
        {
            "role": "user",
            "content": (
                "Summarize what was learned in this tutoring session:\n\n"
                f"{transcript}"
            ),
        },
    ]
    return StreamingResponse(
        stream_ollama_chat(messages),
        media_type="text/event-stream",
    )


@app.post("/api/reset")
async def reset(req: SessionRequest) -> JSONResponse:
    """Clear a session (used by the 'New Chat' button)."""
    sessions.pop(req.session_id, None)
    return JSONResponse({"ok": True})


# ---------------------------------------------------------------------------
# Static SPA mount (must be registered LAST so /api/* routes win)
# ---------------------------------------------------------------------------

STATIC_DIR = Path(__file__).parent / "static"
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
