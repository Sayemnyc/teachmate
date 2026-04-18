#!/usr/bin/env bash
set -e

echo "🔍 Checking prerequisites..."

# Check Python
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 not found. Install from https://python.org"
    exit 1
fi
echo "✅ Python 3 found: $(python3 --version)"

# Check Ollama
if ! command -v ollama &> /dev/null; then
    echo "❌ Ollama not found. Install from https://ollama.com/download"
    exit 1
fi
echo "✅ Ollama found: $(ollama --version)"

# Check if Gemma 4 is pulled
if ! ollama list | grep -q "gemma4:e4b"; then
    echo "⚠️  Model gemma4:e4b not found."
    echo "   Run: ollama pull gemma4:e4b"
    echo "   (9.6GB download, one time only)"
else
    echo "✅ Model gemma4:e4b is available"
fi

# Install Python deps
echo "📦 Installing Python dependencies..."
pip install -r requirements.txt

echo ""
echo "🎉 Ready! Start the app with:"
echo "   uvicorn main:app --reload"
echo ""
echo "   Then open http://localhost:8000"
