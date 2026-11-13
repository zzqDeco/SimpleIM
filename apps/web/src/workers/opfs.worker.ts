import {
  OpfsWorkerStorageCore,
  type OpfsWorkerRequest,
  type OpfsWorkerResponse,
} from "../storage/opfs-protocol.ts";

interface DedicatedOpfsWorkerScope {
  onmessage: ((event: MessageEvent<OpfsWorkerRequest>) => void) | null;
  postMessage(message: OpfsWorkerResponse, transfer?: Transferable[]): void;
}

const workerScope = self as unknown as DedicatedOpfsWorkerScope;
const core = new OpfsWorkerStorageCore();

let serialQueue: Promise<void> = Promise.resolve();

workerScope.onmessage = (event: MessageEvent<OpfsWorkerRequest>) => {
  const req = event.data;
  serialQueue = serialQueue.then(async () => {
    const { response, transfer } = await core.dispatch(req);
    workerScope.postMessage(response, transfer);
  });
};
