import type {
  ClientSignalingFrame,
  ServerSignalingFrame,
} from "@simpleim/contracts";
import type { SignalingClientPort } from "@simpleim/peer-core";
import {
  BrowserSignalingClient,
  type BrowserSignalingClientOptions,
} from "./browser-signaling.ts";

class VirtualRoomSignalingPort implements SignalingClientPort {
  readonly roomId: string;
  private readonly hub: MultiplexedSignalingHub;
  private attached = false;
  private readonly frameHandlers = new Set<(frame: ServerSignalingFrame) => void>();
  private readonly connectionHandlers = new Set<(connected: boolean) => void>();

  constructor(hub: MultiplexedSignalingHub, roomId: string) {
    this.hub = hub;
    this.roomId = roomId;
  }

  get isConnected(): boolean {
    return this.attached && this.hub.isConnected;
  }

  async connect(): Promise<void> {
    this.attached = true;
    await this.hub.ensureConnected(this.roomId, this);
  }

  send(frame: ClientSignalingFrame): void {
    if (!this.attached) return;
    if (frame.roomId !== this.roomId) {
      throw new Error("VirtualRoomSignalingPort roomId mismatch");
    }
    this.hub.send(frame);
  }

  disconnect(): void {
    if (!this.attached) {
      this.frameHandlers.clear();
      this.connectionHandlers.clear();
      return;
    }
    this.attached = false;
    this.frameHandlers.clear();
    this.connectionHandlers.clear();
    this.hub.detachRoomPort(this.roomId, this);
  }

  onServerFrame(handler: (frame: ServerSignalingFrame) => void): void {
    this.frameHandlers.add(handler);
  }

  onConnectionChange(handler: (connected: boolean) => void): void {
    this.connectionHandlers.add(handler);
  }

  deliverFrame(frame: ServerSignalingFrame): void {
    if (!this.attached) return;
    for (const h of this.frameHandlers) {
      h(frame);
    }
  }

  deliverConnectionChange(connected: boolean): void {
    if (!this.attached) return;
    for (const h of this.connectionHandlers) {
      h(connected);
    }
  }
}

export class MultiplexedSignalingHub {
  private readonly transport: SignalingClientPort;
  private readonly roomPorts = new Map<string, VirtualRoomSignalingPort>();
  private connectPromise: Promise<void> | null = null;
  private closed = false;

  constructor(
    optionsOrTransport: BrowserSignalingClientOptions | SignalingClientPort,
  ) {
    if ("connect" in optionsOrTransport && "send" in optionsOrTransport) {
      this.transport = optionsOrTransport;
    } else {
      this.transport = new BrowserSignalingClient(optionsOrTransport);
    }

    this.transport.onServerFrame((frame) => {
      if (this.closed) return;
      this.routeServerFrame(frame);
    });

    this.transport.onConnectionChange((connected) => {
      if (this.closed) return;
      for (const port of this.roomPorts.values()) {
        port.deliverConnectionChange(connected);
      }
    });
  }

  get isConnected(): boolean {
    return !this.closed && this.transport.isConnected;
  }

  get activeRoomCount(): number {
    return this.roomPorts.size;
  }

  createRoomPort(roomId: string): SignalingClientPort {
    if (this.closed) {
      throw new Error("MultiplexedSignalingHub is closed");
    }
    const existing = this.roomPorts.get(roomId);
    if (existing) {
      return existing;
    }
    const port = new VirtualRoomSignalingPort(this, roomId);
    this.roomPorts.set(roomId, port);
    return port;
  }

  async ensureConnected(
    roomId: string,
    port: VirtualRoomSignalingPort,
  ): Promise<void> {
    if (this.closed) {
      throw new Error("MultiplexedSignalingHub is closed");
    }
    this.roomPorts.set(roomId, port);
    if (this.transport.isConnected) {
      return;
    }
    if (!this.connectPromise) {
      this.connectPromise = this.transport.connect().finally(() => {
        this.connectPromise = null;
      });
    }
    await this.connectPromise;
  }

  send(frame: ClientSignalingFrame): void {
    if (this.closed) return;
    this.transport.send(frame);
  }

  detachRoomPort(roomId: string, port: VirtualRoomSignalingPort): void {
    const current = this.roomPorts.get(roomId);
    if (current === port) {
      this.roomPorts.delete(roomId);
    }
    if (this.roomPorts.size === 0 && !this.closed) {
      this.transport.disconnect();
    }
  }

  closeAll(): void {
    if (this.closed) return;
    this.closed = true;
    this.roomPorts.clear();
    this.transport.disconnect();
  }

  private routeServerFrame(frame: ServerSignalingFrame): void {
    switch (frame.type) {
      case "room.joined":
      case "room.peer_joined":
      case "room.peer_left":
      case "signal.deliver": {
        const target = this.roomPorts.get(frame.roomId);
        target?.deliverFrame(frame);
        break;
      }
      case "error": {
        if (frame.roomId !== undefined) {
          const target = this.roomPorts.get(frame.roomId);
          target?.deliverFrame(frame);
        } else {
          for (const port of this.roomPorts.values()) {
            port.deliverFrame(frame);
          }
        }
        break;
      }
    }
  }
}
