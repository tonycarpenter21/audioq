/**
 * @fileoverview Optional Web Audio routing. iOS ignores `HTMLAudioElement.volume`, so volume control
 * there requires a GainNode. One AudioContext is shared per queue and created only when needed.
 */

import type { WebAudioMode, WebAudioSupport } from './types.js';

type AudioContextConstructor = new () => AudioContext;

/** Gain routing for one element. */
export interface GainRoute {
  /** Gain node controlling the element's output volume. */
  gain: GainNode;
  /** Stereo panner, when the browser has StereoPannerNode (Safari 14.1+, all others). */
  panner: StereoPannerNode | undefined;
  /** Source node wrapping the element. */
  source: MediaElementAudioSourceNode;
}

/**
 * Detects iOS and iPadOS (which reports itself as a Mac with touch support).
 * @returns True on iOS/iPadOS
 */
export const isIOSDevice = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  const userAgent = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(userAgent)) return true;
  return userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1;
};

/**
 * Returns the AudioContext constructor, if the environment has one.
 * @returns The constructor or undefined
 */
export const getAudioContextClass = (): AudioContextConstructor | undefined => {
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext;
};

/**
 * Whether the Web Audio API is available.
 * @returns True when an AudioContext constructor exists
 */
export const isWebAudioSupported = (): boolean => getAudioContextClass() !== undefined;

/**
 * Whether new items should be routed through Web Audio in the given mode.
 * @param mode - Configured mode
 * @returns True when Web Audio should be used
 */
export const shouldUseWebAudio = (mode: WebAudioMode): boolean => {
  if (mode === 'off' || !isWebAudioSupported()) return false;
  return mode === 'force' || isIOSDevice();
};

/**
 * Describes Web Audio availability and use for a mode.
 * @param mode - Configured mode
 * @returns Support information with a readable reason
 */
export const describeWebAudioSupport = (mode: WebAudioMode): WebAudioSupport => {
  const available = isWebAudioSupported();
  const isIOS = isIOSDevice();
  const usingWebAudio = shouldUseWebAudio(mode);
  let reason: string;
  if (mode === 'off') reason = 'Web Audio disabled (webAudio: "off")';
  else if (!available) reason = 'Web Audio API not available in this environment';
  else if (mode === 'force') reason = 'Web Audio forced (webAudio: "force")';
  else if (isIOS) {
    reason = 'iOS detected: audio uses Web Audio only while its volume is between 0 and 1';
  } else reason = 'Using HTMLAudioElement volume (Web Audio only needed on iOS)';
  return { available, isIOS, reason, usingWebAudio };
};

/**
 * Lazily-created shared AudioContext plus per-element gain routing.
 */
export class WebAudioEngine {
  private context: AudioContext | undefined;

  /**
   * Routes an element through a new GainNode. Returns undefined if routing fails, in which case
   * the element keeps playing through its normal output.
   * @param element - Element to route
   * @param initialGain - Starting gain (0-1)
   * @param initialPan - Starting stereo position (-1 left to 1 right)
   * @param output - Node the route plays into (the speakers by default; a channel's analyser)
   * @returns The route, or undefined
   */
  connect(
    element: HTMLAudioElement,
    initialGain: number,
    initialPan: number = 0,
    output?: AudioNode
  ): GainRoute | undefined {
    const context = this.getContext();
    if (!context) return undefined;
    try {
      const source = context.createMediaElementSource(element);
      const gain = context.createGain();
      gain.gain.value = initialGain;
      source.connect(gain);
      const panner =
        typeof context.createStereoPanner === 'function' ? context.createStereoPanner() : undefined;
      if (panner) {
        panner.pan.value = initialPan;
        gain.connect(panner);
      }
      (panner ?? gain).connect(output ?? context.destination);
      this.resume();
      return { gain, panner, source };
    } catch {
      return undefined;
    }
  }

  /**
   * Sets a route's gain immediately.
   * @param route - Route to change
   * @param value - Gain (0-1)
   */
  setGain(route: GainRoute, value: number): void {
    const param = route.gain.gain;
    if (typeof param.cancelScheduledValues === 'function' && this.context) {
      param.cancelScheduledValues(this.context.currentTime);
    }
    param.value = value;
  }

  /**
   * Creates an analyser on the shared context, playing into the speakers. Routes connected to it
   * (see {@link setOutput}) can then be measured.
   * @returns The analyser, or undefined without Web Audio
   */
  createAnalyser(): AnalyserNode | undefined {
    const context = this.getContext();
    if (!context) return undefined;
    try {
      const analyser = context.createAnalyser();
      analyser.connect(context.destination);
      return analyser;
    } catch {
      return undefined;
    }
  }

  /**
   * Sends a route into another node (for example a channel's analyser) instead of its current
   * output.
   * @param route - Route to change
   * @param output - Node to play into
   */
  setOutput(route: GainRoute, output: AudioNode): void {
    const last = route.panner ?? route.gain;
    try {
      last.disconnect();
      last.connect(output);
    } catch {
      // A node from a closed context; the route is being released.
    }
  }

  /**
   * Sets a route's stereo position. Ignored where StereoPannerNode is missing.
   * @param route - Route to change
   * @param value - Position (-1 left to 1 right)
   */
  setPan(route: GainRoute, value: number): void {
    if (route.panner) route.panner.pan.value = value;
  }

  /**
   * Disconnects a route so its nodes can be garbage collected.
   * @param route - Route to disconnect
   */
  disconnect(route: GainRoute): void {
    try {
      route.source.disconnect();
      route.gain.disconnect();
      route.panner?.disconnect();
    } catch {
      // Already disconnected.
    }
  }

  /**
   * Resumes the context if the browser suspended it (autoplay policy) or iOS interrupted it
   * (phone call, Siri). Never throws.
   */
  resume(): void {
    const state = this.context?.state as string | undefined;
    if (state === 'suspended' || state === 'interrupted') {
      this.context?.resume().catch(() => undefined);
    }
  }

  /** Closes the shared context. A later `connect` creates a new one. */
  close(): void {
    const context = this.context;
    this.context = undefined;
    if (context && context.state !== 'closed') {
      context.close().catch(() => undefined);
    }
  }

  private getContext(): AudioContext | undefined {
    if (this.context) return this.context;
    const AudioContextClass = getAudioContextClass();
    if (!AudioContextClass) return undefined;
    try {
      this.context = new AudioContextClass();
    } catch {
      return undefined;
    }
    return this.context;
  }
}
