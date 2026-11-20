// New-message chime (feature 002, T088, FR-037): two short tones made with the Web Audio API, so
// no sound file is shipped. Browsers start audio only after the first click or key press on the
// page; until then the chime is silently skipped.

/** At most one chime every two seconds, however many messages arrive. */
const MIN_GAP_MS = 2_000;

let context: AudioContext | null = null;
let lastPlayed = 0;

export function playChime(): void {
  const now = Date.now();
  if (now - lastPlayed < MIN_GAP_MS || typeof window === 'undefined' || typeof AudioContext === 'undefined') return;
  lastPlayed = now;
  try {
    context ??= new AudioContext();
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
    const start = context.currentTime;
    [880, 1320].forEach((frequency, i) => {
      const at = start + i * 0.12;
      const oscillator = context!.createOscillator();
      const gain = context!.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.2, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.25);
      oscillator.connect(gain).connect(context!.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.3);
    });
  } catch {
    // Audio is unavailable (no output device, or blocked): alerts still show visually.
  }
}
