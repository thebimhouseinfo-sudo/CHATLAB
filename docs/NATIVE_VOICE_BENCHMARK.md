# CHATLAB native speech benchmark — Android APK / iOS app

CHATLAB is a **React Native app**, not a web app or a remote browser tab.
Inference for Qwen GGUF runs locally via llama.rn.
The speech test in this APK is a native integration using the device's speech
recognizer and installed system TTS voice services.

## Current app baseline

- Microphone press → native speech recognition (Vietnamese `vi-VN` or English `en-US`).
- Recognized text → unchanged system prompt and inference settings for Qwen 0.8B/2B.
- Qwen result → installed device TTS engine via `expo-speech`.
- The app enumerates available system voice profiles and lets the user compare
  different installed Vietnamese/English voices.
- Benchmarks include STT latency, original LLM prompt/decode timing, time from
  TTS call to the native onStart callback, and total speech callback duration.
- Time from microphone press to TTS onStart includes the user's speaking time.
  The callback is **not** a hardware first-PCM timestamp.
- Per-chat report payload keeps these metrics for optional manual Push.
- No model behavior correction, spellcheck or LoRA modifications.

## New APK test: offline STT + native Vietnamese TTS

This branch now includes **two independent speech engines** to test on Beam Pro.

- **STT Whisper Tiny multilingual** (`sherpa-onnx-whisper-tiny`, ~116 MB
  compressed) — tap `↓ Tải STT offline` once, then use `🎙 Whisper`.
  Press `■ Chốt Mic` after speaking. Native PCM capture is 16 kHz; the
  Whisper model runs on-device. The transcript is editable before sending.
  A manual selector also keeps the Android SpeechRecognizer path for comparison.
- **Vietnamese TTS Piper** (`vits-piper-vi_VN-vais1000-medium-int8`,
  ~22 MB archive) — select `TTS: Piper AI` and install once. The app
  generates Vietnamese audio with sherpa-onnx and uses native PCM playback.
  This is a **different model** from KEVoice's browser MMS.
- **System TTS** via `expo-speech` remains an option, including VI/EN
  test phrases and diagnostics. Android manifest now queries TTS and
  RecognitionService via the Expo config plugin.
- The APK uses `react-native-safe-area-context` for the status/navigation
  bars and the expanded keyboard editor, rather than the deprecated
  `SafeAreaView` that handled only iOS properly.

Suggested test utterance, then edit and confirm before Qwen:
`Tôi đang benchmark local model và AI offline trên Beam Pro.`

Benchmark STT with separate capture-duration, offline inference and model-load
timings. Benchmark native Piper synthesis, generated audio duration and RTF.
Time to native PCM enqueue is only a proxy for first audible sample.

**Acceptance still pending:** CI must produce an APK and an actual Beam Pro
installation must confirm mic input, transcription accuracy, native PCM
playback, Media volume and absence of crashes. The source implementation alone
does not establish success.

## KeVoice compatibility

The original KEVoice `Xenova/mms-tts-vie` adapter uses browser
Transformers.js/ONNX-WASM with Worker/Web Audio/IndexedDB, so the APK does
not import it directly or load a remote WebView. Piper VITS is an **independent
native comparator**, not a claim that MMS/KeVoice weights now work natively.
A future native MMS integration would require verifying/exporting model files
and tokenizer compatibility.

No spelling correction or behavioral changes to the Qwen model were introduced.
