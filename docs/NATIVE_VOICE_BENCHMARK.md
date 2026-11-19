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

## KEVoice Vietnamese native model: separate step, not falsely marked as working

The current KEVoice `Xenova/mms-tts-vie` adapter is a browser
Transformers.js/ONNX-WASM implementation requiring Worker, Web Audio and
IndexedDB. It cannot be imported into the React Native native runtime as-is.

**Rejected path:** do not load an externally hosted KEVoice webpage in
CHATLAB's WebView. That introduces a cloud-dependent HTML/JS bridge and does
not validate standalone native APK synthesis. The previous experimental bridge
is intentionally removed from CHATLAB.

Native candidate: the upstream `react-native-sherpa-onnx` library supports
on-device VITS TTS, with Expo-compatible native build support. However the
`Xenova/mms-tts-vie` ONNX export must be validated or converted for its VITS
runtime and tokenizer; do not assume the browser ONNX is immediately compatible.
For an initial native comparison, sherpa-onnx provides ready-made **Vietnamese
Piper VITS** packages (different weights/voice than MMS/KEVoice):
`vits-piper-vi_VN-vivos-x_low` and
`vits-piper-vi_VN-vais1000-medium`. Evaluate their model license and quality
separately.

Native KEVoice acceptance prerequisites:
1. Pin a tested React Native sherpa-onnx runtime and a verified license for the
   Vietnamese VITS model, download it to app storage on user request.
2. Load ONNX + tokenizer/config completely on device, without a remote WebView.
3. Produce speech, play it natively, measure cold/warm model load, synthesis,
   output audio duration, RTF and first-playback callback.
4. Run the same Vietnamese test phrases against selected Android system voices.
5. Confirm APK installs and speaks on Beam Pro before reporting native
   Vietnamese AI-TTS as functional.

Until that is done, this APK offers **system TTS only** as a real baseline.
The KEVoice project remains useful for a separate model evaluation but is not
mistaken for the app's built-in runtime.
