"""Synthesize deterministic cue sounds from the compiled DirectorTimeline clock."""
import argparse
import hashlib
import json
from pathlib import Path
import wave

import numpy as np


def read_wav(path):
    with wave.open(str(path), 'rb') as file:
        if file.getsampwidth() != 2 or file.getframerate() != 48000:
            raise ValueError('Voice input must be 48 kHz signed 16-bit PCM WAV')
        channels = file.getnchannels()
        if channels not in (1, 2):
            raise ValueError('Voice input must be mono or stereo')
        values = np.frombuffer(file.readframes(file.getnframes()), dtype='<i2').astype(np.float64) / 32768
        source = values.reshape(-1, channels)
        # Match FFmpeg's equal-power center pan when the source voice is mono.
        return np.repeat(source / np.sqrt(2), 2, axis=1) if channels == 1 else source, channels


def write_wav(path, values):
    if path.exists():
        raise FileExistsError(f'Retaining existing audio: {path}')
    with wave.open(str(path), 'wb') as file:
        file.setnchannels(2)
        file.setsampwidth(2)
        file.setframerate(48000)
        pcm = np.clip(values, -.999, .999)
        stereo = np.repeat(pcm[:, None], 2, axis=1) if pcm.ndim == 1 else pcm
        file.writeframes((stereo * 32767).astype('<i2').tobytes())


def cue_sound(kind, seed):
    duration = {'whoosh': .24, 'impact': .22, 'settle': .18}[kind]
    t = np.arange(round(duration * 48000)) / 48000
    if kind == 'whoosh':
        noise = np.random.default_rng(seed).normal(0, 1, len(t))
        filtered = np.convolve(noise, np.ones(5) / 5, mode='same')
        values = filtered * np.sin(np.pi * t / duration) ** 2
    elif kind == 'impact':
        values = np.cos(2 * np.pi * (92 * t - 30 * t * t)) * np.exp(-24 * t)
    else:
        values = np.sin(2 * np.pi * 780 * t) * np.exp(-28 * t)
    return values / max(.001, np.max(np.abs(values))) * .12


def rms_db(values):
    return float(20 * np.log10(max(1e-9, np.sqrt(np.mean(values * values)))))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--voice', type=Path)
    parser.add_argument('--out-dir', type=Path, required=True)
    options = parser.parse_args()
    data = json.loads(options.input.read_text(encoding='utf-8-sig'))
    timeline = data['timeline']
    count = round(timeline['totalFrames'] * 48000 / timeline['fps'])
    options.out_dir.mkdir(parents=True, exist_ok=False)
    voice = np.zeros((count, 2))
    voice_channels = None
    if options.voice:
        source, voice_channels = read_wav(options.voice)
        if abs(len(source) - count) > 1:
            raise ValueError('Voice sample count differs from the locked timeline; explicit trimming is required')
        voice[:min(len(source), count)] = source[:count]
    # A 120 ms window keeps short spoken pauses from causing per-syllable pumping.
    block = 5760
    levels = np.array([np.sqrt(np.mean(voice[i:i+block] ** 2)) for i in range(0, count, block)])
    envelope = np.interp(np.arange(count), np.arange(len(levels)) * block + block / 2, levels)
    duck = 1 - .62 * np.clip(envelope / .035, 0, 1)
    effects = np.zeros(count)
    events = []
    for cue in timeline['audioCues']:
        start = round(cue['globalFrame'] * 48000 / timeline['fps'])
        values = cue_sound(cue['kind'], int.from_bytes(hashlib.sha256(cue['id'].encode()).digest()[:4], 'little')) * cue['gain']
        end = min(count, start + len(values))
        effects[start:end] += values[:end-start] * duck[start:end]
        actual_values = values[:end-start] * duck[start:end]
        nonzero = np.flatnonzero(actual_values)
        onset_offset = int(nonzero[0]) if len(nonzero) else None
        events.append({'id': cue['id'], 'globalFrame': cue['globalFrame'], 'sample': start, 'seconds': start / 48000, 'kind': cue['kind'], 'gain': cue['gain'], 'actualNonzeroSamples': int(np.count_nonzero(actual_values)), 'actualOnsetSample': start + onset_offset if onset_offset is not None else None, 'onsetOffsetSamples': onset_offset, 'onsetOffsetFrames': onset_offset * timeline['fps'] / 48000 if onset_offset is not None else None})
    mixed = voice + effects[:, None]
    peak = float(np.max(np.abs(mixed)))
    if peak >= .999:
        raise ValueError(f'Clipping requires a gain change: peak={peak}')
    write_wav(options.out_dir / 'cues.wav', effects)
    write_wav(options.out_dir / 'mixed.wav', mixed)
    windows = []
    for start in range(0, count, 48000):
        end = min(start + 48000, count)
        windows.append({'startS': start / 48000, 'endS': end / 48000, 'voiceRMSdBFS': rms_db(voice[start:end]), 'cueRMSdBFS': rms_db(effects[start:end]), 'mixedRMSdBFS': rms_db(mixed[start:end]), 'minCueDuck': float(np.min(duck[start:end]))})
    evidence = {'schemaVersion': 1, 'sampleRate': 48000, 'samples': count, 'timelineSHA256': hashlib.sha256(options.input.read_bytes()).hexdigest(), 'voiceSHA256': hashlib.sha256(options.voice.read_bytes()).hexdigest() if options.voice else None, 'voiceSourceChannels': voice_channels, 'monoVoiceToStereoGain': float(1 / np.sqrt(2)) if voice_channels == 1 else 1, 'music': 'none; only sparse event cues are synthesized', 'events': events, 'oneSecondLocalLevels': windows, 'mixedPeak': peak, 'clippedSamples': 0, 'humanListeningPerformed': False}
    (options.out_dir / 'audio-qa.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': 'sample_clock_audio_compiled', 'samples': count, 'events': len(events), 'outDir': str(options.out_dir)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
