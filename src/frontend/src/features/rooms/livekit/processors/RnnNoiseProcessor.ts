import { Track, TrackProcessor, ProcessorOptions } from 'livekit-client'

// Use Jitsi's approach: maintain a global AudioContext variable
// and suspend/resume it as needed to manage audio state
let audioContext: AudioContext

// load wasm files and worklet
const loadedFiles: {
  error: string | undefined;
  wasmBlob: ArrayBuffer | undefined;
  wasmJS: string | undefined;
  worklet: BlobPart;
} = {
  // store first caught error
  error: undefined,
  // BBBA-mapi.wasm
  wasmBlob: undefined,
  // BBBA-mapi.js
  wasmJS: undefined,
  // mapi-proc.js
  worklet: '',
};

const loadFiles = () => {
  return new Promise<void>((success, reject) => {
    // return early if already loaded before
    if (typeof loadedFiles.error !== 'undefined') {
      reject(loadedFiles.error);
      return;
    }
    if (loadedFiles.wasmBlob && loadedFiles.wasmJS && loadedFiles.worklet) {
      success();
      return;
    }

    if (typeof AudioContext === 'undefined') {
      loadedFiles.error = 'AudioContext unsupported';
      reject(loadedFiles.error);
      return;
    }
    if (typeof WebAssembly === 'undefined') {
      loadedFiles.error = 'WebAssembly unsupported';
      reject(loadedFiles.error);
      return;
    }
    // eslint-disable-next-line max-len
    if (!WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 2, 8, 1, 1, 97, 1, 98, 3, 127, 1, 6, 6, 1, 127, 1, 65, 0, 11, 7, 5, 1, 1, 97, 3, 1]))) {
      loadedFiles.error = 'Importable/Exportable mutable globals unsupported';
      reject(loadedFiles.error);
      return;
    }

    // check if SIMD is supported, needed for old Safari versions
    const supportsSIMD = WebAssembly.validate(
      // eslint-disable-next-line max-len
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]),
    );

    const catchHandler = (error: string) => {
      // only reject Promise once
      if (!loadedFiles.error) {
        loadedFiles.error = error;
        reject(loadedFiles.error);
      }
    };

    const checkResolved = () => {
      if (loadedFiles.wasmBlob && loadedFiles.wasmJS && loadedFiles.worklet) {
        success();
      }
    };

    // load wasm files and worklet
    const basepath = '/wasm/';
    const suffix = supportsSIMD ? '' : '-nosimd';
    fetch(`${basepath}BBBA${suffix}-mapi.wasm`).then((resp) => {
      resp.arrayBuffer().then((bytes) => {
        loadedFiles.wasmBlob = bytes;
        checkResolved();
      }).catch(catchHandler);
    }).catch(catchHandler);
    fetch(`${basepath}BBBA${suffix}-mapi.js`).then((resp) => {
      resp.text().then((text) => {
        loadedFiles.wasmJS = text;
        checkResolved();
      }).catch(catchHandler);
    }).catch(catchHandler);
    fetch(`${basepath}mapi-proc.js`).then((resp) => {
      resp.text().then((text) => {
        loadedFiles.worklet = text;
        checkResolved();
      }).catch(catchHandler);
    }).catch(catchHandler);
  });
};

export interface AudioProcessorInterface
  extends TrackProcessor<Track.Kind.Audio> {
  name: string
}

export class RnnNoiseProcessor implements AudioProcessorInterface {
  name: string = 'noise-reduction'
  processedTrack?: MediaStreamTrack

  private source?: MediaStreamTrack
  private sourceNode?: MediaStreamAudioSourceNode
  private destinationNode?: MediaStreamAudioDestinationNode
  private noiseSuppressionNode?: AudioWorkletNode

  async init(opts: ProcessorOptions<Track.Kind.Audio>) {
    if (!opts.track) {
      throw new Error('Track is required for audio processing')
    }

    this.source = opts.track as MediaStreamTrack

    if (!audioContext) {
      audioContext = new AudioContext()
    } else {
      await audioContext.resume()
    }

    await loadFiles();

    const processorBlob = new Blob([loadedFiles.worklet], { type: 'text/javascript' });
    const processorURL = URL.createObjectURL(processorBlob);

    await audioContext.audioWorklet.addModule(processorURL)

    this.sourceNode = audioContext.createMediaStreamSource(
      new MediaStream([this.source])
    )


    this.noiseSuppressionNode = new AudioWorkletNode(
      audioContext,
      'mapi-proc'
    )
    const nn = this.noiseSuppressionNode;
    this.noiseSuppressionNode.port.onmessage = (event) => {
      if (event.data?.type === 'loaded') {
        nn.port.postMessage({ type: 'param', symbol: "intensity", value: 90 });
        nn.port.postMessage({ type: 'param', symbol: "leveler_target", value: -18 });
        nn.port.postMessage({ type: 'param', symbol: "sb_strength", value: 60 });
        nn.port.postMessage({ type: 'param', symbol: "mb_strength", value: 60 });
        nn.port.postMessage({ type: 'param', symbol: "pre_gain", value: 2 });
        nn.port.postMessage({ type: 'param', symbol: "post_gain", value: 0 });
      }
    };
    this.noiseSuppressionNode.port.postMessage({ type: 'init', wasm: loadedFiles.wasmBlob, js: loadedFiles.wasmJS });
    this.destinationNode = audioContext.createMediaStreamDestination()

    // Connect the audio processing chain
    this.sourceNode
      .connect(this.noiseSuppressionNode)
      .connect(this.destinationNode)

    // Get the processed track
    const tracks = this.destinationNode.stream.getAudioTracks()
    if (tracks.length === 0) {
      throw new Error('No audio tracks found for processing')
    }

    this.processedTrack = tracks[0]
  }

  async restart(opts: ProcessorOptions<Track.Kind.Audio>) {
    await this.destroy()
    return this.init(opts)
  }

  async destroy() {
    // Clean up audio nodes and context
    this.sourceNode?.disconnect()
    this.noiseSuppressionNode?.disconnect()
    this.destinationNode?.disconnect()

    /**
     * Audio Context Lifecycle Management
     *
     * We prefer suspending the audio context rather than destroying and recreating it
     * to avoid memory leaks in WebAssembly-based audio processing.
     *
     * Issue: When an AudioContext containing WebAssembly modules is destroyed,
     * the WASM resources are not properly garbage collected. This causes:
     * - Retained JavaScript VM instances
     * - Growing memory consumption over multiple create/destroy cycles
     * - Potential performance degradation
     *
     * Solution: Use suspend() and resume() methods instead of close() to maintain
     * the same context instance while controlling audio processing state.
     */
    await audioContext.suspend()

    this.sourceNode = undefined
    this.destinationNode = undefined
    this.source = undefined
    this.processedTrack = undefined
    this.noiseSuppressionNode = undefined
  }
}
