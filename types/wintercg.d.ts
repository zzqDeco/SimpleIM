declare class TextEncoder {
  readonly encoding: string;
  encode(input?: string): Uint8Array;
}

declare class TextDecoder {
  readonly encoding: string;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  decode(input?: ArrayBufferView | ArrayBuffer, options?: { stream?: boolean }): string;
}

declare function setTimeout(handler: () => void, timeout?: number): ReturnType<typeof globalThis.setTimeout>;
declare function clearTimeout(id: unknown): void;
declare function setInterval(handler: () => void, timeout?: number): ReturnType<typeof globalThis.setInterval>;
declare function clearInterval(id: unknown): void;
