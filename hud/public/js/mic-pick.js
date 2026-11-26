/**
 * Which microphone the page opens. A Bluetooth headset's own microphone switches the headphones into
 * their call mode (HFP: mono, 16 kHz) for as long as it is open, and Jarvis then sounds canned in them.
 * When the default input is a Bluetooth headset and the computer has a built-in microphone, that one
 * is used instead, so the headphones keep their full sound. The native Mac app does the same (main.swift).
 * Labels are empty before the first microphone permission: then the default input is used.
 */
const BLUETOOTH = /bluetooth|airpods|buds|headset|hands-?free|\bbt\b|\d+bt\b/i
const BUILT_IN = /macbook|built-?in|internal|vstavan|integr|interný|interní/i

/** The device's audio constraints with the built-in microphone chosen when that avoids the headset's call mode. */
export async function micAudio(audio = {}) {
  try {
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
    const def = inputs.find((d) => d.deviceId === 'default') ?? inputs[0]
    if (!def || !BLUETOOTH.test(def.label)) return audio
    const builtIn = inputs.find((d) => d.deviceId !== 'default' && d.deviceId !== 'communications' && BUILT_IN.test(d.label) && !BLUETOOTH.test(d.label))
    return builtIn ? { ...audio, deviceId: { exact: builtIn.deviceId } } : audio
  } catch {
    return audio
  }
}
