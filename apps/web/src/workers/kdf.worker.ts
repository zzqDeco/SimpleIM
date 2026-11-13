import { deriveRoomKeys, type DeriveRoomKeyOptions } from "@simpleim/crypto";

export interface KdfWorkerRequest {
  id: number;
  passphrase: string;
  options?: DeriveRoomKeyOptions;
}

export type KdfWorkerResponse =
  | {
      id: number;
      ok: true;
      roomId: string;
      roomIdPrefix: string;
      signalingKeyBuffer: ArrayBuffer;
      roomAuthKeyBuffer: ArrayBuffer;
      roomAppKeyBuffer: ArrayBuffer;
    }
  | {
      id: number;
      ok: false;
      error: string;
    };

interface DedicatedKdfWorkerScope {
  onmessage: ((event: MessageEvent<KdfWorkerRequest>) => void) | null;
  postMessage(message: KdfWorkerResponse, transfer?: Transferable[]): void;
}

function detachArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  bytes.fill(0);
  return copy.buffer;
}

const workerScope = self as unknown as DedicatedKdfWorkerScope;

workerScope.onmessage = (event: MessageEvent<KdfWorkerRequest>) => {
  const { id, passphrase, options } = event.data;
  try {
    const keys = deriveRoomKeys(passphrase, options);
    const signalingKeyBuffer = detachArrayBuffer(keys.signalingKey);
    const roomAuthKeyBuffer = detachArrayBuffer(keys.roomAuthKey);
    const roomAppKeyBuffer = detachArrayBuffer(keys.roomAppKey);

    workerScope.postMessage(
      {
        id,
        ok: true,
        roomId: keys.roomId,
        roomIdPrefix: keys.roomIdPrefix,
        signalingKeyBuffer,
        roomAuthKeyBuffer,
        roomAppKeyBuffer,
      },
      [signalingKeyBuffer, roomAuthKeyBuffer, roomAppKeyBuffer],
    );
  } catch (err) {
    workerScope.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
