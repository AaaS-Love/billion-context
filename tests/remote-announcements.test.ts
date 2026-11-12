import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// #5548 P3: remote announcements (GitHub raw feed). Hermetic: XDG_CACHE_HOME
// isolates throttle + snapshot files, BILI_CONFIG_FILE/XDG_STATE_HOME isolate
// the local-source and dismissal-store interplay; feed endpoints are local
// http servers on OS-assigned ports (no fixed-port assumptions, #360).

const root = fs.mkdtempSync(path.join(os.tmpdir(), "remote-ann-"));
process.env.BILI_CONFIG_FILE = path.join(root, "cfg.json"); // absent ⇒ defaults
process.env.XDG_STATE_HOME = path.join(root, "state");
process.env.XDG_CACHE_HOME = path.join(root, "cache");
const annDir = path.join(root, "announcements");
const snapshotFile = path.join(root, "cache", "billion-context", ".remote-notices-snapshot.json");

const { resolveAnnouncementsUrl, parseRemoteDoc, runRemoteNoticesCheck, visibleRemoteRecords, remoteAnnouncementPayloads, remoteDismissMode, getRemoteNoticesState, _resetRemoteNoticesForTest } = await import("../src/remote-notices.ts");
const { mergedNotices } = await import("../src/announcements.ts");

const REC = (over: Record<string, unknown> = {}): Record<string, unknown> => Object.assign({
    id: "team-note",
    kind: "suggestion",
    title: { "zh-CN": "提示", en: "Note" },
    desc: { "zh-CN": "说明文字", en: "Description text" },
}, over);
const doc = (entries: unknown[]): string => JSON.stringify({ v: 1, entries });

function serve(handler: (res: http.ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
    const srv = http.createServer((req, res) => handler(res));
    return new Promise((resolve) => {
        srv.listen(0, "127.0.0.1", () => {
            const addr = srv.address();
            const port = typeof addr === "object" && addr ? addr.port : 0;
            resolve({ url: `http://127.0.0.1:${port}/feed`, close: async () => { srv.closeAllConnections(); await new Promise<void>((r) => srv.close(() => r())); } });
        });
    });
}

test("resolveAnnouncementsUrl: official default, override verbatim", () => {
    assert.equal(resolveAnnouncementsUrl(undefined), "https://raw.githubusercontent.com/ranxianglei/billion-context/master/announcements/remote.json");
    assert.equal(resolveAnnouncementsUrl(""), resolveAnnouncementsUrl(undefined));
    const relay = "http://relay.internal/bili/remote.json";
    assert.equal(resolveAnnouncementsUrl(relay), relay);
});

test("parseRemoteDoc: shape matrix, per-entry isolation, version gate", () => {
    // The source contract: parse takes the PARSED object; callers (fetch path,
    // snapshot restore, CI validator) do the JSON.parse themselves.
    assert.deepEqual(parseRemoteDoc(JSON.parse(doc([REC()]))), { entries: [{ ...REC(), tone: "info", dismiss: "persistent", priority: 50 }] });
    assert.ok(parseRemoteDoc(JSON.parse(doc([]))).entries.length === 0 && !parseRemoteDoc(JSON.parse(doc([]))).error, "empty entries is a valid document (retraction)");
    assert.match(parseRemoteDoc({ ...JSON.parse(doc([REC()])), v: 2 }).error ?? "", /unsupported version 2/, "higher version skips the WHOLE doc");
    assert.match(parseRemoteDoc({ entries: [REC()] }).error ?? "", /missing integer v/);
    assert.match(parseRemoteDoc({ v: 1 }).error ?? "", /not an array/);
    assert.match(parseRemoteDoc("oops").error ?? "", /not a JSON object/, "raw strings are not documents (that is the caller's job)");
    const many = Array.from({ length: 51 }, (_, i) => REC({ id: `n${String(i).padStart(2, "0")}` }));
    assert.match(parseRemoteDoc(JSON.parse(doc(many))).error ?? "", /too many entries/, "document cap before per-entry work");
    const mixed = [REC(), { id: "BAD_ID" }, null, REC({ id: "second-entry" })];
    const r = parseRemoteDoc(JSON.parse(doc(mixed)));
    assert.equal(r.error, undefined);
    assert.deepEqual(r.entries.map((e) => e.id), ["team-note", "second-entry"], "bad individual entries are skipped, good ones survive");
    assert.match(parseRemoteDoc(JSON.parse(doc([{ id: "BAD_ID" }]))).error ?? "", /no valid entries/);
    const dupes = [REC(), REC()];
    assert.equal(parseRemoteDoc(JSON.parse(doc(dupes))).entries.length, 1, "duplicate ids dedupe to first");
});




test("slow response trips the fetch timeout and falls back", async () => {
    _resetRemoteNoticesForTest();
    fs.rmSync(snapshotFile, { force: true });
    const slow = await serve((res) => setTimeout(() => res.end(doc([REC()])), 30_000));
    const t0 = Date.now();
    try {
        await runRemoteNoticesCheck({ remoteAnnouncementsUrl: slow.url, timeoutMs: 300, log: () => {} }, true);
    } finally {
        await slow.close();
    }
    assert.ok(Date.now() - t0 < 30_000, "aborted well before the server would have answered");
    assert.equal(visibleRemoteRecords().length, 0);
    assert.match(getRemoteNoticesState().lastError ?? "", /\S+/, "timeout surfaced as a recorded error");
});



