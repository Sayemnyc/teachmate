# TeachMate: Offline-First AI Tutoring for Every Classroom

> *A patient, Socratic AI tutor that runs entirely on a teacher's laptop.
> No internet, no cloud, no cost per question, no student data leaving the
> building.*

---

## The Problem

According to UNESCO, **258 million children and youth worldwide are out of
school or lack access to quality education**. The numbers hide a deeper,
structural inequity: in rural villages across Sub-Saharan Africa, in island
schools in Southeast Asia, on reservations in North America, and in the
forgotten corners of Eastern Europe, the barrier isn't just a missing
teacher. It's a missing connection. Bandwidth that's measured in kilobits.
Internet that works for an hour, then disappears for three days.
Electricity that arrives late in the afternoon, if at all.

The last five years of AI tutoring products (Khan Academy's Khanmigo,
Duolingo Max, every shiny new chatbot) share one fatal
assumption: a student has a fast, always-on link to a data center
thousands of miles away. When the link breaks, the tutor vanishes.
When the bill comes, a school district with $11 per pupil per year for
technology simply can't pay the per-seat subscription. The most
transformative educational technology of our generation has been built
for the students who need it least.

Meanwhile, the open-weight models coming out of Google DeepMind have
quietly crossed a threshold. **Gemma 4's e4b variant fits in under 10 GB
and runs at readable speeds on a $300 laptop.** It sees images. It
reasons across subjects. It speaks gently. For the first time, the best
teacher a child has ever had can live on a USB stick, and belong
to *them*.

## Our Solution

**TeachMate is a locally-hosted AI tutoring web application that runs
entirely on-device using Gemma 4 via Ollama.** After a one-time model
pull, the teacher's laptop becomes a private tutor that serves every
student in the classroom, with no internet connection, no API keys,
no recurring costs, and no student data ever leaving the building.

The architecture is deliberately simple: a small FastAPI backend
forwards streaming responses from a local Ollama instance, a single
HTML/CSS/JS single-page app renders a warm, WhatsApp-style chat, and
Gemma 4 does the rest. A student picks a subject (Math, Science,
History, English, or Geography), types a question, and watches the
tutor's response arrive token-by-token. If they're stuck on a photo
in their textbook, they upload it, and Gemma 4's vision capability
reads the page and walks them through the problem like a human tutor
would.

The product's personality is opinionated and pedagogical. The system
prompt is the soul of the app: *"Your job is NOT to give direct answers,
but to guide students toward understanding through questions, hints, and
step-by-step explanations. Always be positive and never make the
student feel bad for not knowing something."* Every conversation is a
little Socratic dialogue. Ask TeachMate to solve `2x + 3 = 11` and it
won't say "four." It will ask you what you could do to both sides to
get `x` alone, and then celebrate when you get there. This matters.
Every education researcher from Piaget to Bloom has told us that
*discovering* an answer cements it in a way that *receiving* one never
does. A tutor who gives away the answer is just a faster way to fail
the next test.

Two meta-actions round out the pedagogy. **"Explain Like I'm 10"** takes
the last tutor response and re-generates it in the simplest possible
words with a friendly analogy, a lifeline for the student who's
struggling to parse the vocabulary, not the idea. **"Summarize My
Session"** produces bullet-point study notes at the end of a
conversation, turning an hour of back-and-forth into something you can
stick to the fridge. Both actions are meta-prompts against the live
conversation; neither mutates the history, so the main tutoring thread
stays clean.

Streaming is the final touch that makes the app feel alive. Gemma 4's
NDJSON output from Ollama is forwarded frame-by-frame through
Server-Sent Events, decoded in the browser, and painted directly into
the current message bubble. On a modest laptop the first token arrives
in a few seconds, and the rest unspools at reading speed. No spinners,
no dead air: the tutor is thinking *with* you.

## Why Gemma 4

TeachMate exists because of specific choices Google DeepMind made in
building Gemma 4. **Vision is the first one.** A student's homework
lives in a textbook, on a blackboard, on a crumpled worksheet, not in
a typed LaTeX expression. Gemma 4's native multimodal input means the
barrier to getting help drops from "type the problem accurately" (which
pre-supposes the student already understands it) to "take a picture."
For a struggling learner, that gap is the difference between asking for
help and giving up. **The e4b size is the second.** At roughly 9.6 GB,
the model fits comfortably on consumer hardware and runs at readable
token rates on the mid-range laptops that actually exist in schools.
Any larger, and the "works on a teacher's laptop" promise breaks. Any
smaller, and the tutoring quality wouldn't survive the honest
comparison to a human.

**Open weights are the third choice that matters, and it's structural,
not technical.** A school in a country under a US export restriction
can't rely on a cloud API. A parent who doesn't want a photo of their
child's homework uploaded to a corporation can't use one either.
Gemma 4's open weights mean TeachMate is auditable, portable, and
sovereign, and the teacher owns the tool. Gemma 4's function-calling
support gives us a clear path forward: future versions will let the
tutor read a local SQLite of past sessions, call a symbolic math
engine when a student is doing algebra, or query a curriculum map to
align with a specific syllabus. The foundation is the model. Gemma 4
is the first one we could actually build *on*.

## Technical Architecture

- **Backend** (`main.py`, ~300 lines): FastAPI with four endpoints:
  `/api/chat` (streaming), `/api/explain-simple` (streaming meta),
  `/api/summarize` (streaming meta), `/api/health` (status badge). An
  `httpx.AsyncClient` opens a keep-alive HTTP stream to Ollama's
  `POST /api/chat` with `stream: true`, then an async generator
  re-emits each NDJSON line as a Server-Sent Event. Session state is
  a plain in-memory `dict[str, dict]` keyed by a browser-generated
  UUID, with no database, no persistence, and no user accounts.

- **Model interface**: Ollama's chat API accepts OpenAI-style message
  arrays with a `system` prompt at index 0, plus a bespoke `images:
  [base64...]` field on user turns for multimodal input. TeachMate
  injects a per-subject system prompt on session creation and refreshes
  it in place when the user switches subjects. This is a small but
  important detail, since otherwise subject switches leak the wrong pedagogy into
  the next answer.

- **Frontend** (`app.js`, ~300 lines, zero dependencies): a single
  module parses the SSE stream with `ReadableStream` + `TextDecoder`,
  handling partial frames that split across chunk boundaries. Image
  uploads are read as data URLs via `FileReader`, stripped to raw
  base64, and piggybacked on the next chat request. The offline-status
  badge polls `/api/health` every 30 seconds so that a late
  `ollama serve` flips the UI green without a reload. Everything is
  mobile-responsive; the composer stacks under 640px, tap targets grow,
  and the font size holds at 16 px to prevent the dreaded iOS auto-zoom.

- **Styling**: warm off-white background, soft blue + yellow accents,
  fully rounded corners, subtle shadows. Friendly for ages 10 to 16
  without being childish. CSS-only animations for the "thinking" dots
  and token fade-in keep the bundle tiny.

## Accessibility Beyond the Laptop

The v1 target is a $300 refurbished laptop, but the architecture
generalizes down from there. Gemma 4 ships in an even smaller form
factor: the e2b variant weighs in at roughly 7.2 GB and runs on capable
Android phones via Termux plus Ollama. Because TeachMate's backend is
just FastAPI, the same process can bind to 0.0.0.0 and serve every
student in a classroom from one phone on a local Wi-Fi hotspot. No
new code is required to turn a single teacher's handset into a shared
school resource. The roadmap calls for an Android-native wrapper so
families who never own a laptop can still use it directly on the
device in their pocket. The backend is ready today.

## Real-World Impact

Picture a teacher in a rural secondary school. Her laptop cost her
three hundred US dollars, refurbished. The school's internet works on
Tuesday afternoons. She has forty-three students and teaches five
subjects. She can't be everywhere at once, and she knows it. She
watches the quiet ones fall behind every semester because they're too
shy to ask in front of the class.

This morning she opens TeachMate. The model is already on her disk.
The browser loads `localhost:8000`. She hands the laptop to her
quietest student and says *ask it anything*. Ten minutes later the
student walks back with a grin and a worksheet covered in her own
handwriting, because the tutor didn't tell her the answer. It taught
her how to find it.

**258 million children.** Most of them will never see a cloud AI
tutor. All of them could, in principle, meet one that lives on a
laptop somebody already owns. TeachMate is a proof that the second
path is real, buildable today, and small enough to fit in a
thumb drive. Gemma 4 made the teacher. We just opened the door.
