#!/usr/bin/env bash
# TeachMate one-line installer
# Usage:  curl -fsSL https://raw.githubusercontent.com/Sayemnyc/teachmate/main/bootstrap.sh | bash
set -e

REPO_URL="https://github.com/Sayemnyc/teachmate.git"
INSTALL_DIR="${TEACHMATE_DIR:-$HOME/teachmate}"
MODEL="gemma4:e4b"

echo "================================================"
echo "  TeachMate one-line installer"
echo "================================================"
echo ""

# ---- OS detection ----
OS="$(uname -s)"
if [[ "$OS" != "Darwin" && "$OS" != "Linux" ]]; then
    echo "❌ Unsupported OS: $OS"
    echo "   This installer supports macOS and Linux."
    echo "   Windows users: follow the manual steps in README.md, or use WSL."
    exit 1
fi
echo "✅ OS: $OS"

# ---- Python 3.10+ check ----
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 not found."
    if [[ "$OS" == "Darwin" ]]; then
        echo "   Install with:  brew install python@3.12"
        echo "   Or download:   https://python.org"
    else
        echo "   Debian/Ubuntu: sudo apt install python3 python3-pip python3-venv"
        echo "   Fedora:        sudo dnf install python3 python3-pip"
    fi
    exit 1
fi

PY_VER=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
PY_MAJOR=$(echo "$PY_VER" | cut -d. -f1)
PY_MINOR=$(echo "$PY_VER" | cut -d. -f2)
if [[ "$PY_MAJOR" -lt 3 || ( "$PY_MAJOR" -eq 3 && "$PY_MINOR" -lt 10 ) ]]; then
    echo "❌ Python 3.10+ required, found $PY_VER"
    exit 1
fi
echo "✅ Python $PY_VER"

if ! python3 -m pip --version &> /dev/null; then
    echo "❌ pip is not available for python3."
    echo "   Install with: python3 -m ensurepip --upgrade"
    exit 1
fi
echo "✅ pip available"

# ---- Git check ----
if ! command -v git &> /dev/null; then
    echo "❌ git not found. Install from https://git-scm.com/downloads"
    exit 1
fi
echo "✅ git available"

# ---- Ollama install ----
if ! command -v ollama &> /dev/null; then
    echo ""
    echo "📥 Installing Ollama..."
    curl -fsSL https://ollama.com/install.sh | sh
else
    echo "✅ Ollama already installed"
fi

# ---- Make sure Ollama server is running ----
if ! curl -fsS http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo "🚀 Starting Ollama server in background..."
    nohup ollama serve > /tmp/ollama.log 2>&1 &
    for i in 1 2 3 4 5 6 7 8 9 10; do
        if curl -fsS http://localhost:11434/api/tags > /dev/null 2>&1; then
            break
        fi
        sleep 1
    done
fi

if ! curl -fsS http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo "⚠️  Ollama server didn't start automatically."
    echo "   Open the Ollama app (macOS) or run 'ollama serve' in another terminal, then rerun."
    exit 1
fi
echo "✅ Ollama server is reachable"

# ---- Pull model ----
if ollama list 2>/dev/null | grep -q "$MODEL"; then
    echo "✅ Model $MODEL already available"
else
    echo ""
    echo "📥 Pulling $MODEL (~9.6 GB, one-time download, go grab coffee)..."
    ollama pull "$MODEL"
fi

# ---- Clone or update repo ----
if [[ -d "$INSTALL_DIR/.git" ]]; then
    echo "✅ Repo already at $INSTALL_DIR, pulling latest..."
    git -C "$INSTALL_DIR" pull --ff-only
else
    echo ""
    echo "📥 Cloning TeachMate into $INSTALL_DIR..."
    git clone "$REPO_URL" "$INSTALL_DIR"
fi

# ---- Install Python deps ----
echo ""
echo "📦 Installing Python dependencies..."
python3 -m pip install -r "$INSTALL_DIR/requirements.txt"

# ---- Done ----
echo ""
echo "================================================"
echo "  🎉 All set!"
echo "================================================"
echo ""
echo "Start the app:"
echo "  cd $INSTALL_DIR"
echo "  uvicorn main:app --reload"
echo ""
echo "Then open http://localhost:8000"
