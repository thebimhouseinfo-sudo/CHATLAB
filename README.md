# CHATLAB — Native Offline Qwen Chat & Benchmark

A real React Native / Expo app for **iPhone, iPad and Android**. Runs GGUF entirely on device through [llama.rn](https://github.com/mybigday/llama.rn) (llama.cpp). No API key, no cloud inference, no bundled model weights.

**Status:** source implementation / CI build candidate. Native compilation and on-device inference must be verified; do not label any model PASS until tested on a real phone.

## Models — download on demand

| Model | Quant | Download source | Approx size |
|---|---|---|---:|
| Qwen3.5 0.8B Original Lite | Q3_K_M | bartowski/Qwen_Qwen3.5-0.8B-GGUF | 518 MB |
| Qwen3.5 0.8B Original Base | Q4_K_M | bartowski/Qwen_Qwen3.5-0.8B-GGUF | 580 MB |
| Qwen3.5 0.8B Astra Edited | Q4_K_M | NotCherry/Qwen3.5-0.8B-weight-space-programming-GGUF | ~550 MB |
| Qwen3.5 2B Original Lite | Q3_K_M | bartowski/Qwen_Qwen3.5-2B-GGUF | 1.22 GB |
| Qwen3.5 2B Original Base | Q4_K_M | bartowski/Qwen_Qwen3.5-2B-GGUF | 1.40 GB |

Sizes are approximate transfer sizes, not peak RAM. Models are fetched from Hugging Face only after the user chooses Download. An interrupted download is never treated as ready.

## App functionality

- Native iOS/Android conversation (Vietnamese and English) with streaming response, clear chat bubbles and Stop.
- **New Chat** creates a fresh conversation; last 40 conversation histories are saved on-device and can be reopened.
- Compact model picker: switch among installed GGUFs, automatically unload old runtime before loading another. Chats remain attributed to the model that generated them.
- Adjustable context 2K / 4K / 8K (requires model reload). Prompt token count is calculated from the actual chat template and model tokenizer; the full conversation is sent until the configured context fills. No arbitrary last-8-message truncation.
- Pick/download/load/unload/delete one model at a time; no more than one loaded LLM context.
- Live, per-turn benchmark: wall-clock TTFT, provisional tokens/s while generating; **native** prefill tokens/s, decode tokens/s, generated/prompt tokens and total duration once completed.
- Records model ID, quant, OS, device, CPU/Metal mode, load time and errors; export a CSV by native Share.
- No fabricated RAM reading: this release does not attempt app process RAM measurement.
- Default context 2048, optional 4096 / 8192; max response 160 tokens (reduced only when the remaining context is insufficient), non-thinking and fixed sampling settings for comparisons.
- Full-context stress test exposes prompt tokens / context window, peak prompt tokens, number of turns, overflow warning and native truncated flag; it does not advertise 8K as a guaranteed stable maximum on every device.
- CSV stores chat ID, turn index, configured context, prompt token usage, requested token budget and native truncation status for each turn.
- iOS uses Metal if llama.rn makes it available; Android starts CPU-only to keep a consistent low-end baseline.

## Build Android APK

1. Open [Actions](https://github.com/thebimhouseinfo-sudo/CHATLAB/actions), choose **Android APK (native llama.cpp)** on the feature branch and inspect results.
2. If the build succeeds, download artifact **CHATLAB-Android-APK** and install its APK on a physical Android device (allow test app installation).
3. For local builds: install Android SDK, JDK 17, Node 22, then run:

~~~bash
npm install
npm run typecheck
npx expo prebuild --platform android --clean
cd android && ./gradlew assembleRelease
~~~

Release output uses the generated Android project's signing settings. The APK is for private testing, **not a store release**. Inspect the APK signature before installation.

## Build for a real iPhone / iPad

Requires **a Mac with Xcode and Apple signing**. A GitHub repository alone cannot issue a signed, installable IPA without your signing setup.

~~~bash
npm install
npx expo prebuild --platform ios --clean
npx expo run:ios --device
~~~

Select your signing team in the Xcode project if prompted. **Expo Go cannot run this app** because llama.rn includes native libraries; use a development/native build.

## Reproducible comparison

For each model, use the same preset prompts and generation parameters, after a fresh load. Use **New Chat** to reset the conversation, then continue asking follow-up questions until the context warning or runtime limit occurs. Reopen older conversations from **Lịch sử**; reopen the matching GGUF before continuing a saved thread. Record first-turn and warmed-up runs separately. Don't compare models on different context lengths, phones or thermal conditions as if they were identical. Use multiple runs (for example 5–10) and compare median throughput and TTFT. Check actual output quality, not just speed.

Model loading/unloading and downloads are experimental. If the OS terminates the app, record the model, device, RAM tier, context and reproduction steps. Avoid opening other memory-heavy apps while testing.

## Planned next steps

On-device real-world validation; downloadable signed Android APK; iOS developer-signed installation; temperature and memory diagnostics via optional platform-native profiling; STT from OS and later LoRA behavior packs. Those are **not** completed features of v0.1.

## License and source attribution

CHATLAB app source is a test scaffold. Qwen model and quantized versions retain their respective upstream licenses. The Astra-edited checkpoint is a separate model source; validate its model card and license before redistribution. No weight files are committed to GitHub.
