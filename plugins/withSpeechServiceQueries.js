// Android 11+ package visibility: SpeechRecognizer and TextToSpeech need queries.
// Plugin is additive and runs during 'expo prebuild --clean', keeping the APK reproducible.
const { withAndroidManifest } = require('expo/config-plugins');

module.exports = function withSpeechServiceQueries(config) {
  return withAndroidManifest(config, mod => {
    const manifest = mod.modResults.manifest;
    if (!manifest.queries || manifest.queries.length === 0) manifest.queries = [{}];
    const queries = manifest.queries[0];
    const intents = queries.intent || [];
    const actions = [
      'android.intent.action.TTS_SERVICE',
      'android.speech.RecognitionService',
    ];
    for (const actionName of actions) {
      const present = intents.some(intent => (intent.action || []).some(item =>
        item.$ && item.$['android:name'] === actionName));
      if (!present) {
        intents.push({ action: [{ $: { 'android:name': actionName } }] });
      }
    }
    queries.intent = intents;
    return mod;
  });
};
