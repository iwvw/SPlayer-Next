/**
 * 外部 API REST 路由
 *
 * 查询用 GET，控制用 POST。
 * 业务实现全部复用主进程既有服务，这里只做参数校验与转发。
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { app as electronApp } from "electron";
import { ZodError, z } from "zod/v4";
import * as nowPlaying from "@main/services/nowPlaying";
import { playerControl } from "@main/services/playerControl";
import {
  getAlbumList,
  getAlbumTracks,
  getAllTracks,
  getArtistList,
  getArtistTracks,
  getLibraryStats,
  getRandomTracks,
  getTrackCount,
} from "@main/database";
import {
  onlineSearchSchema,
  queueQuerySchema,
  searchLibrary,
  searchOnline,
  trackSchema,
} from "@main/services/music";
import { getWsClientCount } from "./broadcast";

/** 一次替换队列允许的最大曲目数 */
const MAX_QUEUE_TRACKS = 2000;

/** 统一的错误响应 */
const fail = (c: Context, error: unknown) => {
  const status: 400 | 500 = error instanceof ZodError ? 400 : 500;
  return c.json({ error: error instanceof Error ? error.message : String(error) }, status);
};

/**
 * 注册 HTTP 查询与控制入口,业务操作复用主进程服务
 * @returns 外部 API 路由
 */
export const buildRoutes = (): Hono => {
  const api = new Hono();

  // ---------- 基础信息 ----------

  api.get("/info", (c) =>
    c.json({
      name: electronApp.getName(),
      version: electronApp.getVersion(),
      wsClients: getWsClientCount(),
    }),
  );

  api.get("/status", (c) => {
    const status = playerControl.getStatus();
    return c.json({
      state: status.state,
      position: status.positionMs,
      duration: status.durationMs,
      volume: status.volume,
      isFinished: status.isFinished,
      currentIndex: status.currentIndex,
      repeat: status.repeat,
      shuffle: status.shuffle,
    });
  });

  api.get("/volume", (c) => c.json({ volume: playerControl.getStatus().volume }));

  api.get("/now-playing", (c) => c.json(nowPlaying.lightSnapshot()));

  api.get("/lyrics", (c) => c.json(nowPlaying.lyricSnapshot()));

  // ---------- 队列 ----------

  api.get("/queue", async (c) => {
    const offset = c.req.query("offset");
    const limit = c.req.query("limit");
    try {
      return c.json(
        await playerControl.getQueue({
          offset: offset === undefined ? undefined : Number(offset),
          limit: limit === undefined ? undefined : Number(limit),
        }),
      );
    } catch (error) {
      return fail(c, error);
    }
  });

  // ---------- 播放控制 ----------

  api.post("/play", (c) => {
    playerControl.play();
    return c.json({ ok: true });
  });

  api.post("/pause", (c) => {
    playerControl.pause();
    return c.json({ ok: true });
  });

  api.post("/stop", (c) => {
    playerControl.stop();
    return c.json({ ok: true });
  });

  api.post("/next", (c) => {
    playerControl.next();
    return c.json({ ok: true });
  });

  api.post("/prev", (c) => {
    playerControl.prev();
    return c.json({ ok: true });
  });

  api.post("/seek", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { positionMs?: number } | null;
    const positionMs = Number(body?.positionMs);
    if (!Number.isFinite(positionMs) || positionMs < 0) {
      return c.json({ error: "positionMs (number, >=0) required" }, 400);
    }
    try {
      await playerControl.seek(positionMs);
    } catch (err) {
      return fail(c, err);
    }
    return c.json({ ok: true });
  });

  api.post("/volume", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { volume?: number } | null;
    const volume = Number(body?.volume);
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
      return c.json({ error: "volume (number, 0..1) required" }, 400);
    }
    playerControl.setVolume(volume);
    return c.json({ ok: true });
  });

  /** 跳到队列指定位置并播放 */
  api.post("/play-index", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { index?: number } | null;
    const index = Number(body?.index);
    if (!Number.isInteger(index) || index < 0) {
      return c.json({ error: "index (integer, >=0) required" }, 400);
    }
    playerControl.playAt(index);
    return c.json({ ok: true });
  });

  /** 播放模式：循环 list(列表) / one(单曲) */
  api.post("/repeat", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { mode?: string } | null;
    const mode = body?.mode;
    if (mode !== "list" && mode !== "one") {
      return c.json({ error: "mode (list|one) required" }, 400);
    }
    playerControl.setRepeat(mode);
    return c.json({ ok: true, mode });
  });

  /** 播放模式：随机 on / off */
  api.post("/shuffle", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { mode?: string } | null;
    const mode = body?.mode;
    if (mode !== "on" && mode !== "off") {
      return c.json({ error: "mode (on|off) required" }, 400);
    }
    playerControl.setShuffle(mode);
    return c.json({ ok: true, mode });
  });

  /** 播放指定曲目（加入队列后立即播放） */
  api.post("/play-track", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { track?: unknown } | null;
    const parsed = trackSchema.safeParse(body?.track);
    if (!parsed.success) {
      return c.json({ error: "track (Track) required" }, 400);
    }
    playerControl.playTrack(parsed.data);
    return c.json({ ok: true, id: parsed.data.id });
  });

  /** 用给定曲目替换整个队列并从第一首开始播放 */
  api.post("/play-queue", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { tracks?: unknown } | null;
    const parsed = z.array(trackSchema).min(1).max(MAX_QUEUE_TRACKS).safeParse(body?.tracks);
    if (!parsed.success) {
      return c.json({ error: `tracks (Track[1..${MAX_QUEUE_TRACKS}]) required` }, 400);
    }
    playerControl.playQueue(parsed.data);
    return c.json({ ok: true, count: parsed.data.length });
  });

  /** 追加曲目到队列：position 为 next(当前之后) 或 end(末尾) */
  api.post("/queue/add", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      tracks?: unknown;
      position?: string;
    } | null;
    const parsed = z.array(trackSchema).min(1).max(MAX_QUEUE_TRACKS).safeParse(body?.tracks);
    if (!parsed.success) {
      return c.json({ error: "tracks (Track[]) required" }, 400);
    }
    const position = body?.position === "end" ? "end" : "next";
    playerControl.addToQueue(parsed.data, position);
    return c.json({ ok: true, count: parsed.data.length, position });
  });

  /** 调整当前曲目的歌词偏移 */
  api.post("/lyric-offset", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { offsetMs?: number } | null;
    const offsetMs = Number(body?.offsetMs);
    if (!Number.isFinite(offsetMs)) {
      return c.json({ error: "offsetMs (number) required" }, 400);
    }
    const trackId = nowPlaying.lightSnapshot().track?.id;
    if (!trackId) {
      return c.json({ error: "no current track" }, 409);
    }
    nowPlaying.setLyricOffset(trackId, Math.round(offsetMs));
    return c.json({ ok: true, trackId, offsetMs: Math.round(offsetMs) });
  });

  // ---------- 本地曲库 ----------

  api.get("/library/summary", (c) => {
    const stats = getLibraryStats();
    return c.json({ ...stats, albums: getAlbumList().length, artists: getArtistList().length });
  });

  api.get("/library/albums", (c) => {
    const limit = Number(c.req.query("limit") ?? 100);
    const albums = getAlbumList();
    return c.json({
      total: albums.length,
      albums: albums.slice(0, Number.isFinite(limit) ? Math.max(1, limit) : 100),
    });
  });

  api.get("/library/artists", (c) => {
    const limit = Number(c.req.query("limit") ?? 100);
    const artists = getArtistList();
    return c.json({
      total: artists.length,
      artists: artists.slice(0, Number.isFinite(limit) ? Math.max(1, limit) : 100),
    });
  });

  api.get("/library/album/tracks", (c) => {
    const name = c.req.query("name");
    if (!name) return c.json({ error: "name required" }, 400);
    const tracks = getAlbumTracks(name);
    return c.json({ name, total: tracks.length, tracks });
  });

  api.get("/library/artist/tracks", (c) => {
    const name = c.req.query("name");
    if (!name) return c.json({ error: "name required" }, 400);
    const tracks = getArtistTracks(name);
    return c.json({ name, total: tracks.length, tracks });
  });

  api.get("/library/tracks", (c) => {
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
    const tracks = getAllTracks();
    return c.json({
      total: tracks.length,
      offset,
      tracks: tracks.slice(offset, offset + limit),
    });
  });

  api.get("/library/search", (c) => {
    const query = c.req.query("query");
    if (!query) return c.json({ error: "query required" }, 400);
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20) || 20));
    return c.json(searchLibrary(query, limit));
  });

  api.get("/library/random", (c) => {
    const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? 10) || 10));
    return c.json({ tracks: getRandomTracks(limit) });
  });

  api.get("/library/count", (c) => c.json({ tracks: getTrackCount() }));

  // ---------- 按专辑 / 歌手整单播放 ----------

  api.post("/play-album", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { name?: string } | null;
    const name = body?.name?.trim();
    if (!name) return c.json({ error: "name required" }, 400);
    const tracks = getAlbumTracks(name);
    if (tracks.length === 0) return c.json({ error: "album not found" }, 404);
    playerControl.playQueue(tracks);
    return c.json({ ok: true, name, count: tracks.length });
  });

  api.post("/play-artist", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { name?: string } | null;
    const name = body?.name?.trim();
    if (!name) return c.json({ error: "name required" }, 400);
    const tracks = getArtistTracks(name);
    if (tracks.length === 0) return c.json({ error: "artist not found" }, 404);
    playerControl.playQueue(tracks);
    return c.json({ ok: true, name, count: tracks.length });
  });

  // ---------- 在线搜索 ----------

  api.get("/search/online", async (c) => {
    const parsed = onlineSearchSchema.safeParse({
      platform: c.req.query("platform"),
      query: c.req.query("query"),
      page: c.req.query("page") === undefined ? undefined : Number(c.req.query("page")),
      limit: c.req.query("limit") === undefined ? undefined : Number(c.req.query("limit")),
    });
    if (!parsed.success) {
      return c.json({ error: "platform (netease|qqmusic|kugou) and query required" }, 400);
    }
    return c.json(await searchOnline(parsed.data));
  });

  // 兼容：读取队列时用的分页参数校验（保持与 MCP 一致的错误码）
  api.get("/queue/validate", (c) => {
    const parsed = queueQuerySchema.safeParse({
      offset: c.req.query("offset") === undefined ? undefined : Number(c.req.query("offset")),
      limit: c.req.query("limit") === undefined ? undefined : Number(c.req.query("limit")),
    });
    return parsed.success
      ? c.json({ ok: true, ...parsed.data })
      : c.json({ error: "invalid queue query" }, 400);
  });

  return api;
};
