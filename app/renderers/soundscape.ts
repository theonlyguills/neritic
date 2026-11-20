import * as T from 'three'

/**
 * Marine soundscape on the Web Audio API (via three's AudioListener on the camera).
 *
 * Procedural, driven by the simulation (no assets):
 * - engine: low diesel drone with propeller-blade pulse, positioned in the engine room;
 * - hull wash: filtered noise at the bow that swells when the bow plunges (same surge
 *   value that drives the bow foam), and a steady churn at the stern;
 * - wind: band-passed noise with slow gusts, non-positional.
 * Recorded one-shots (optional, loaded if present): gull calls from the gulls' actual
 * positions, and deck clanks/chain rattles from the working deck, more likely in a lurch.
 */
export interface SoundSamples {
  gulls: string[]
  deck: string[]
  /** Optional looping sea bed recording, mixed under the procedural layers. */
  sea?: string
}

const NOISE_SECONDS = 4

function noiseBuffer(context: AudioContext, colour: 'pink' | 'brown') {
  const length = context.sampleRate * NOISE_SECONDS
  const buffer = context.createBuffer(1, length, context.sampleRate)
  const data = buffer.getChannelData(0)
  let b0 = 0,
    b1 = 0,
    b2 = 0,
    last = 0
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1
    if (colour === 'brown') {
      last = (last + 0.02 * white) / 1.02
      data[i] = last * 3.5
    } else {
      b0 = 0.99765 * b0 + white * 0.099046
      b1 = 0.963 * b1 + white * 0.2965164
      b2 = 0.57 * b2 + white * 1.0526913
      data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.11
    }
  }
  // Crossfade the ends so the loop has no click.
  const fade = Math.floor(context.sampleRate * 0.05)
  for (let i = 0; i < fade; i++) {
    const t = i / fade
    data[i] = data[i]! * t + data[length - fade + i]! * (1 - t)
  }
  return buffer
}

export class Soundscape {
  listener = new T.AudioListener()
  private context: AudioContext
  private loops: AudioScheduledSourceNode[] = []
  private emitters: T.PositionalAudio[] = []
  private bowGain: GainNode
  private bowFilter: BiquadFilterNode
  private windGain: GainNode
  private windFilter: BiquadFilterNode
  private gullBuffers: AudioBuffer[] = []
  private deckBuffers: AudioBuffer[] = []
  private gullVoices: T.PositionalAudio[] = []
  private deckVoices: T.PositionalAudio[] = []
  private nextGull = 2
  private nextDeck = 4
  private clock = 0
  private enabled = true
  private active = false

  constructor(
    camera: T.Camera,
    boat: T.Object3D,
    scene: T.Scene,
    hull: { length: number; deckY: number },
    samples: SoundSamples,
  ) {
    camera.add(this.listener)
    this.context = this.listener.context
    this.listener.setMasterVolume(0)
    const ctx = this.context
    // Gentle bus compression keeps gull and clank peaks from clipping over the bed.
    const bus = ctx.createDynamicsCompressor()
    bus.threshold.value = -18
    bus.ratio.value = 4
    bus.attack.value = 0.01
    bus.release.value = 0.3
    this.listener.gain.disconnect()
    this.listener.gain.connect(bus).connect(ctx.destination)
    const pink = noiseBuffer(ctx, 'pink')
    const brown = noiseBuffer(ctx, 'brown')
    const loop = (buffer: AudioBuffer) => {
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.loop = true
      source.loopStart = Math.random() * NOISE_SECONDS * 0.5
      source.start(0, source.loopStart)
      this.loops.push(source)
      return source
    }
    // Procedural layers feed an emitter's panner directly (three positions it each frame).
    const emitter = (
      input: AudioNode,
      parent: T.Object3D,
      position: T.Vector3,
      refDistance: number,
    ) => {
      const audio = new T.PositionalAudio(this.listener)
      audio.setRefDistance(refDistance)
      audio.setRolloffFactor(1.2)
      audio.setDistanceModel('inverse')
      audio.position.copy(position)
      parent.add(audio)
      this.emitters.push(audio)
      input.connect(audio.getOutput())
    }

    // Engine room: diesel firing harmonics + blade-rate pulse, heavily low-passed.
    const engineMix = ctx.createGain()
    engineMix.gain.value = 0.5
    const engineFilter = ctx.createBiquadFilter()
    engineFilter.type = 'lowpass'
    engineFilter.frequency.value = 160
    for (const [f, type, level] of [
      [27.5, 'sawtooth', 0.5],
      [41.3, 'triangle', 0.35],
      [55.1, 'sawtooth', 0.18],
    ] as const) {
      const osc = ctx.createOscillator()
      osc.type = type
      osc.frequency.value = f * (1 + (Math.random() - 0.5) * 0.004)
      const g = ctx.createGain()
      g.gain.value = level
      osc.connect(g).connect(engineFilter)
      osc.start()
      this.loops.push(osc)
    }
    const pulse = ctx.createOscillator()
    pulse.frequency.value = 3.6 // four-blade propeller at ~55 rpm-equivalent pulse
    const pulseDepth = ctx.createGain()
    pulseDepth.gain.value = 0.08
    pulse.connect(pulseDepth).connect(engineMix.gain)
    pulse.start()
    this.loops.push(pulse)
    engineFilter.connect(engineMix)
    emitter(engineMix, boat, new T.Vector3(0, 2, 6), 14)

    // Bow wash: swells with each plunge.
    this.bowFilter = ctx.createBiquadFilter()
    this.bowFilter.type = 'lowpass'
    this.bowFilter.frequency.value = 500
    this.bowGain = ctx.createGain()
    this.bowGain.gain.value = 0.05
    loop(pink).connect(this.bowFilter).connect(this.bowGain)
    emitter(this.bowGain, boat, new T.Vector3(0, 0.5, -hull.length * 0.42), 10)

    // Stern churn: steady prop wash.
    const sternFilter = ctx.createBiquadFilter()
    sternFilter.type = 'bandpass'
    sternFilter.frequency.value = 350
    sternFilter.Q.value = 0.6
    const sternGain = ctx.createGain()
    sternGain.gain.value = 0.09
    loop(brown).connect(sternFilter).connect(sternGain)
    emitter(sternGain, boat, new T.Vector3(0, 0.5, hull.length * 0.5), 12)

    // Wind across the deck: everywhere, gusting.
    this.windFilter = ctx.createBiquadFilter()
    this.windFilter.type = 'bandpass'
    this.windFilter.frequency.value = 700
    this.windFilter.Q.value = 0.8
    this.windGain = ctx.createGain()
    this.windGain.gain.value = 0.05
    loop(pink).connect(this.windFilter).connect(this.windGain).connect(this.listener.getInput())

    // Voices for one-shots: gulls move with the flock, deck sounds sit on the working deck.
    for (let i = 0; i < 3; i++) {
      const voice = new T.PositionalAudio(this.listener)
      voice.setRefDistance(9)
      voice.setRolloffFactor(1.1)
      scene.add(voice)
      this.gullVoices.push(voice)
    }
    for (const position of [
      new T.Vector3(1.5, hull.deckY + 1, 15),
      new T.Vector3(-2, hull.deckY + 0.5, 5),
      new T.Vector3(0, hull.deckY + 4, 17),
    ]) {
      const voice = new T.PositionalAudio(this.listener)
      voice.setRefDistance(7)
      voice.position.copy(position)
      boat.add(voice)
      this.deckVoices.push(voice)
    }
    void this.load(samples)
  }

  private async load(samples: SoundSamples) {
    const loader = new T.AudioLoader()
    const get = (url: string) => loader.loadAsync(url).catch(() => undefined)
    const [gulls, deck, sea] = await Promise.all([
      Promise.all(samples.gulls.map(get)),
      Promise.all(samples.deck.map(get)),
      samples.sea ? get(samples.sea) : Promise.resolve(undefined),
    ])
    this.gullBuffers = gulls.filter((b): b is AudioBuffer => !!b)
    this.deckBuffers = deck.filter((b): b is AudioBuffer => !!b)
    if (sea) {
      const source = this.context.createBufferSource()
      source.buffer = sea
      source.loop = true
      // Skip MP3 encoder padding at both ends so the loop is seamless.
      source.loopStart = 0.06
      source.loopEnd = sea.duration - 0.06
      const gain = this.context.createGain()
      gain.gain.value = 0.18
      source.connect(gain).connect(this.listener.getInput())
      source.start(0, 0.06)
      this.loops.push(source)
    }
  }

  private level() {
    return this.enabled && this.active ? 1 : 0
  }

  private applyLevel() {
    const gain = this.listener.gain.gain
    const now = this.context.currentTime
    gain.cancelScheduledValues(now)
    gain.setTargetAtTime(this.level() * 1.6, now, 0.4)
    if (this.level() > 0 && this.context.state === 'suspended') void this.context.resume()
  }

  /** The browser only allows audio after a user gesture; call from any click handler too. */
  resume() {
    if (this.level() > 0 && this.context.state === 'suspended') void this.context.resume()
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled
    this.applyLevel()
  }

  setActive(active: boolean) {
    this.active = active
    this.applyLevel()
  }

  /**
   * Advance one frame. `surge` (0–1) is the bow plunge; `gullPosition(i, target)` gives a
   * gull's world position for i in [0, gullCount).
   */
  update(
    dt: number,
    time: number,
    surge: number,
    gullCount: number,
    gullPosition: (i: number, target: T.Vector3) => T.Vector3,
  ) {
    if (this.level() === 0 || this.context.state !== 'running') return
    const now = this.context.currentTime
    this.bowGain.gain.setTargetAtTime(0.04 + surge * 0.3, now, 0.2)
    this.bowFilter.frequency.setTargetAtTime(320 + surge * 900, now, 0.2)
    const gust = 0.5 + 0.5 * Math.sin(time * 0.13) * Math.sin(time * 0.071 + 1.3)
    this.windGain.gain.setTargetAtTime(0.05 + gust * 0.08, now, 0.8)
    this.windFilter.frequency.setTargetAtTime(500 + gust * 600, now, 0.8)
    this.clock += dt
    if (this.gullBuffers.length && this.clock > this.nextGull) {
      const voice = this.gullVoices.find((v) => !v.isPlaying)
      if (voice) {
        gullPosition(Math.floor(Math.random() * gullCount), voice.position)
        voice.setBuffer(this.gullBuffers[Math.floor(Math.random() * this.gullBuffers.length)]!)
        voice.setPlaybackRate(0.92 + Math.random() * 0.16)
        // Gull clips are loud and bright next to the bed; keep them as accents.
        voice.setVolume(0.22 + Math.random() * 0.2)
        voice.play()
      }
      // Gulls call in bursts: short gaps sometimes, longer lulls otherwise.
      this.nextGull =
        this.clock + (Math.random() < 0.4 ? 0.6 + Math.random() : 3 + Math.random() * 7)
    }
    // Deck gear knocks more often when the hull lurches.
    if (
      this.deckBuffers.length &&
      (this.clock > this.nextDeck || (surge > 0.7 && Math.random() < dt * 0.8))
    ) {
      const voice = this.deckVoices[Math.floor(Math.random() * this.deckVoices.length)]!
      if (!voice.isPlaying) {
        voice.setBuffer(this.deckBuffers[Math.floor(Math.random() * this.deckBuffers.length)]!)
        voice.setPlaybackRate(0.9 + Math.random() * 0.2)
        voice.setVolume(0.6 + Math.random() * 0.4)
        voice.play()
      }
      this.nextDeck = this.clock + 5 + Math.random() * 11
    }
  }

  dispose() {
    for (const source of this.loops) {
      try {
        source.stop()
      } catch {
        // Already stopped.
      }
    }
    for (const voice of [...this.gullVoices, ...this.deckVoices, ...this.emitters]) {
      if (voice.isPlaying) voice.stop()
      voice.getOutput().disconnect()
      voice.removeFromParent()
    }
    this.listener.gain.disconnect()
    this.listener.removeFromParent()
    // three shares one AudioContext per page; suspend rather than close so it can be reused.
    void this.context.suspend().catch(() => undefined)
  }
}
