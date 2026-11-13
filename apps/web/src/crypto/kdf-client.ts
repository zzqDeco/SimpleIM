import {
  deriveRoomKeys,
  normalizePassphrase,
  type DerivedRoomKeys,
  type DeriveRoomKeyOptions,
} from "@simpleim/crypto";
import type { KdfWorkerRequest, KdfWorkerResponse } from "../workers/kdf.worker.ts";

let nextRequestId = 1;

export async function deriveRoomKeysOffThread(
  passphrase: string,
  options?: DeriveRoomKeyOptions,
): Promise<DerivedRoomKeys> {
  // Validate passphrase format immediately (and wipe temporary UTF-8 buffer)
  const checkBytes = normalizePassphrase(passphrase);
  checkBytes.fill(0);

  if (typeof Worker === "undefined") {
    return deriveRoomKeys(passphrase, options);
  }

  let worker: Worker;
  try {
    worker = new Worker(new URL("../workers/kdf.worker.ts", import.meta.url), {
      type: "module",
    });
  } catch {
    return deriveRoomKeys(passphrase, options);
  }

  const requestId = nextRequestId++;
  return new Promise<DerivedRoomKeys>((resolve, reject) => {
    const cleanup = (): void => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };

    worker.onmessage = (event: MessageEvent<KdfWorkerResponse>) => {
      const msg = event.data;
      if (!msg || msg.id !== requestId) {
        return;
      }
      cleanup();
      if (!msg.ok) {
        reject(new Error(msg.error));
        return;
      }
      resolve({
        roomId: msg.roomId,
        roomIdPrefix: msg.roomIdPrefix,
        signalingKey: new Uint8Array(msg.signalingKeyBuffer),
        roomAuthKey: new Uint8Array(msg.roomAuthKeyBuffer),
        roomAppKey: new Uint8Array(msg.roomAppKeyBuffer),
      });
    };

    worker.onerror = (event: ErrorEvent) => {
      cleanup();
      reject(new Error(event.message || "Argon2id KDF worker failed"));
    };

    const req: KdfWorkerRequest = {
      id: requestId,
      passphrase,
      ...(options !== undefined ? { options } : {}),
    };
    worker.postMessage(req);
  });
}
