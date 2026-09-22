import { EventEmitter } from "node:events";
import type { SessionRecord } from "./store.ts";

export type LiveEvent =
  | { type: "session"; session: SessionRecord }
  | { type: "transcript"; sessionId: string; id: number; body: string; createdAt: string };

export const bus = new EventEmitter();

export function publish(event: LiveEvent): void {
  bus.emit("live", event);
}
