import { useCallback, useRef } from 'react';
import * as Tone from 'tone';

// Cathedral bell synth - deep resonant bell with harmonics
const createBellSynth = () => {
  // Use additive synthesis for bell-like harmonics
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: {
      type: 'sine',
    },
    envelope: {
      attack: 0.05,
      decay: 1.5,
      sustain: 0.3,
      release: 3.0,
    },
  });

  // Heavy reverb for cathedral feel
  const reverb = new Tone.Reverb({
    decay: 3.0,
    wet: 0.6,
  });

  // Limiter to prevent clipping
  const limiter = new Tone.Limiter(-3);

  synth.connect(reverb);
  reverb.connect(limiter);
  limiter.toDestination();

  synth.volume.value = -18;

  return { synth, reverb, limiter };
};

// Distant bell synth - muffled, quieter version
const createDistantBellSynth = () => {
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: {
      type: 'sine',
    },
    envelope: {
      attack: 0.05,
      decay: 1.0,
      sustain: 0.2,
      release: 2.0,
    },
  });

  // Lowpass filter for muffled distant sound
  const filter = new Tone.Filter({
    frequency: 800,
    type: 'lowpass',
    rolloff: -24,
  });

  // Even heavier reverb for distance
  const reverb = new Tone.Reverb({
    decay: 3.5,
    wet: 0.8,
  });

  const limiter = new Tone.Limiter(-3);

  synth.connect(filter);
  filter.connect(reverb);
  reverb.connect(limiter);
  limiter.toDestination();

  // Much quieter for background notification
  synth.volume.value = -18;

  return { synth, filter, reverb, limiter };
};

// PolySynth for playing overlapped melodies
const createMelodySynth = () => {
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: {
      type: 'sine',
    },
    envelope: {
      attack: 0.02,
      decay: 0.3,
      sustain: 0.4,
      release: 1.5, // Longer release for fade out
    },
  });

  // synth.maxPolyphony = 64;

  // Add reverb for that cathedral feel
  const reverb = new Tone.Reverb({
    decay: 2.0,
    wet: 0.4,
  });

  // Add limiter to prevent clipping when notes stack
  const limiter = new Tone.Limiter(-3);

  // Chain: synth -> reverb -> limiter -> destination
  synth.connect(reverb);
  reverb.connect(limiter);
  limiter.toDestination();

  // Lower volume to give headroom for overlapping notes
  synth.volume.value = -18;

  return { synth, reverb, limiter };
};

// Low melody notes (octave 3 range)
const LOW_PHRASE_1: string[] = [
  'D2', 'E2', 'F2', 'F2', 'E2', 'E2', 'F2', 'D2',
  'C2', 'D2', 'D2', 'E2', 'C2', 'G2', 'F2',
];

// High melody notes (octave 4 range)
const HIGH_PHRASE_1: string[] = [
  'D4', 'E4', 'F4', 'F4', 'E4', 'E4', 'F4', 'D4',
  'C4', 'D4', 'D4', 'E4', 'C4', 'G4', 'F4',
];

// Phrase 1 length (both low and high have same length)
const PHRASE_1_LENGTH = LOW_PHRASE_1.length;

export function useSoundEffects() {
  const melodySynthRef = useRef<ReturnType<typeof createMelodySynth> | null>(null);
  const bellSynthRef = useRef<ReturnType<typeof createBellSynth> | null>(null);
  const distantBellSynthRef = useRef<ReturnType<typeof createDistantBellSynth> | null>(null);
  const isInitializedRef = useRef(false);
  const noteIndexRef = useRef(0);

  // Initialize audio context on first interaction (required by browsers)
  const initializeAudio = useCallback(async () => {
    if (isInitializedRef.current) return;

    await Tone.start();
    melodySynthRef.current = createMelodySynth();
    bellSynthRef.current = createBellSynth();
    distantBellSynthRef.current = createDistantBellSynth();
    isInitializedRef.current = true;
  }, []);

  // Play both low and high melody notes simultaneously
  const playClickSound = useCallback(async () => {
    await initializeAudio();

    if (!melodySynthRef.current) return;

    const { synth } = melodySynthRef.current;
    const lowNote = LOW_PHRASE_1[noteIndexRef.current];
    const highNote = HIGH_PHRASE_1[noteIndexRef.current];

    // Play both notes simultaneously
    synth.triggerAttackRelease([lowNote, highNote], '6n');

    // Advance to next position (cycle through Phrase 1)
    noteIndexRef.current = (noteIndexRef.current + 1) % PHRASE_1_LENGTH;

    return { lowNote, highNote };
  }, [initializeAudio]);

  // Placeholder for hover - disabled for now
  const playHoverSound = useCallback(async () => {
    // Hover sound disabled
  }, []);

  // Cathedral bell for user's own bid confirmed
  const playBidConfirmedSound = useCallback(async () => {
    await initializeAudio();

    if (!bellSynthRef.current) return;

    const { synth } = bellSynthRef.current;
    // Bell-like chord: fundamental + harmonics at 2x, 3x, 5x (approximated with notes)
    // Base note F3 with overtones for rich bell timbre
    const bellNotes = ['F3', 'C4', 'F4', 'A4'];
    synth.triggerAttackRelease(bellNotes, '2n');
  }, [initializeAudio]);

  // Distant muffled bell for others' bids
  const playOtherBidSound = useCallback(async () => {
    await initializeAudio();

    if (!distantBellSynthRef.current) return;

    const { synth } = distantBellSynthRef.current;
    // Same bell chord but will sound muffled due to filter and reverb
    const bellNotes = ['F3', 'C4', 'F4', 'A4'];
    synth.triggerAttackRelease(bellNotes, '2n');
  }, [initializeAudio]);

  // Get current notes info
  const getCurrentNotes = useCallback(() => {
    return {
      low: LOW_PHRASE_1[noteIndexRef.current],
      high: HIGH_PHRASE_1[noteIndexRef.current],
    };
  }, []);

  // Reset melody to beginning
  const resetMelody = useCallback(() => {
    noteIndexRef.current = 0;
  }, []);

  return {
    playClickSound,
    playHoverSound,
    playBidConfirmedSound,
    playOtherBidSound,
    initializeAudio,
    getCurrentNotes,
    resetMelody,
  };
}
