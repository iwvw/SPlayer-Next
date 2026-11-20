/**
 * WebSocket 入口：双向通道
 *
 * Server → Client：
 *   - 连接建立：`{ kind: "hello", clients: N }`
 *   - player 事件：`{ kind: "event", type, data }`（由 wsBroadcast 推）
 *   - 命令 ack：`{ kind: "ack", op }` / `{ kind: "error", op, error }`
 *
 * Client → Server：`{ op: "play" | "pause" | "stop" | "next" | "prev" | "seek" | "setVolume", ... }`
 */

import type { WSContext } from "hono/ws";
import { z } from "zod/v4";
import { serverLog } from "@main/utils/logger";
import { playerControl } from "@main/services/playerControl";
import { trackSchema } from "@main/services/music";
import { addWsClient, removeWsClient, getWsClientCount } from "./broadcast";

/** 单次 WS 消息允许携带的最大曲目数 */
const WS_MAX_QUEUE_TRACKS = 2000;

interface ClientMessage {
  op: string;
  positionMs?: number;
  volume?: number;
  index?: number;
  mode?: string;
  track?: unknown;
  tracks?: unknown;
  position?: "next" | "end";
}

const ack = (ws: WSContext, op: string): void => {
  ws.send(JSON.stringify({ kind: "ack", op }));
};

const fail = (ws: WSContext, op: string, error: string): void => {
  ws.send(JSON.stringify({ kind: "error", op, error }));
};

const dispatchCommand = async (ws: WSContext, msg: ClientMessage): Promise<void> => {
  try {
    switch (msg.op) {
      case "play":
        playerControl.play();
        return ack(ws, msg.op);
      case "pause":
        playerControl.pause();
        return ack(ws, msg.op);
      case "stop":
        playerControl.stop();
        return ack(ws, msg.op);
      case "next":
        playerControl.next();
        return ack(ws, msg.op);
      case "prev":
        playerControl.prev();
        return ack(ws, msg.op);
      case "seek": {
        const positionMs = Number(msg.positionMs);
        if (!Number.isFinite(positionMs) || positionMs < 0) {
          return fail(ws, msg.op, "positionMs (number, >=0) required");
        }
        await playerControl.seek(positionMs);
        return ack(ws, msg.op);
      }
      case "setVolume": {
        const volume = Number(msg.volume);
        if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
          return fail(ws, msg.op, "volume (number, 0..1) required");
        }
        playerControl.setVolume(volume);
        return ack(ws, msg.op);
      }
      case "playAt": {
        const index = Number(msg.index);
        if (!Number.isInteger(index) || index < 0) {
          return fail(ws, msg.op, "index (integer, >=0) required");
        }
        playerControl.playAt(index);
        return ack(ws, msg.op);
      }
      case "setRepeat": {
        const mode = msg.mode;
        if (mode !== "list" && mode !== "one") {
          return fail(ws, msg.op, "mode (list|one) required");
        }
        playerControl.setRepeat(mode);
        return ack(ws, msg.op);
      }
      case "setShuffle": {
        const mode = msg.mode;
        if (mode !== "on" && mode !== "off") {
          return fail(ws, msg.op, "mode (on|off) required");
        }
        playerControl.setShuffle(mode);
        return ack(ws, msg.op);
      }
      case "playTrack": {
        const parsed = trackSchema.safeParse(msg.track);
        if (!parsed.success) {
          return fail(ws, msg.op, "track (Track) required");
        }
        playerControl.playTrack(parsed.data);
        return ack(ws, msg.op);
      }
      case "playQueue": {
        const parsed = z.array(trackSchema).min(1).max(WS_MAX_QUEUE_TRACKS).safeParse(msg.tracks);
        if (!parsed.success) {
          return fail(ws, msg.op, `tracks (Track[1..${WS_MAX_QUEUE_TRACKS}]) required`);
        }
        playerControl.playQueue(parsed.data);
        return ack(ws, msg.op);
      }
      case "addToQueue": {
        const parsed = z.array(trackSchema).min(1).max(WS_MAX_QUEUE_TRACKS).safeParse(msg.tracks);
        if (!parsed.success) {
          return fail(ws, msg.op, "tracks (Track[]) required");
        }
        playerControl.addToQueue(parsed.data, msg.position === "end" ? "end" : "next");
        return ack(ws, msg.op);
      }
      default:
        return fail(ws, msg.op ?? "?", "unknown op");
    }
  } catch (err) {
    fail(ws, msg.op ?? "?", err instanceof Error ? err.message : String(err));
  }
};

export const wsHandlers = {
  onOpen(_evt: Event, ws: WSContext) {
    addWsClient(ws);
    ws.send(JSON.stringify({ kind: "hello", clients: getWsClientCount() }));
  },
  async onMessage(evt: MessageEvent, ws: WSContext) {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(typeof evt.data === "string" ? evt.data : evt.data.toString());
    } catch {
      return fail(ws, "?", "invalid json");
    }
    await dispatchCommand(ws, msg);
  },
  onClose(_evt: CloseEvent, ws: WSContext) {
    removeWsClient(ws);
  },
  onError(_evt: Event, ws: WSContext) {
    serverLog.warn("WS 客户端错误");
    removeWsClient(ws);
  },
};
