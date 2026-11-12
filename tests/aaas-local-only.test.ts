/**
 * AaaS fork guards. Each test states one property of the hardened build:
 *   - no outbound connection except the configured model upstream (socket-level check)
 *   - loopback-only bind
 *   - removed commands refuse
 *   - the fetch sites of self-update / advisory / announcements / policy refuse
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";

const ROOT = resolve(import.meta.dirname, "..");
const ENTRY = process.env.BILI_ENTRY ?? join(ROOT, "dist", "index.js");
const PRELOAD = join(ROOT, "tests", "fixtures", "egress-log-preload.cjs");
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"]);

function freshHome(): string {
    return mkdtempSync(join(tmpdir(), "bili-aaas-"));
}
function envFor(home: string, extra: Record<string, string>): NodeJS.ProcessEnv {
    return { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData"), XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local"), ...extra };
}
const randPort = () => 20000 + Math.floor(Math.random() * 20000);

test("runtime makes no outbound connection except the configured upstream", async () => {
    const home = freshHome();
    const log = join(home, "egress.jsonl");
    const upstreamHits: string[] = [];
    const upstream = createServer((req, res) => {
        upstreamHits.push(req.url ?? "");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upPort = (upstream.address() as AddressInfo).port;
    const proxyPort = randPort();
    const child = spawn(process.execPath, ["--require", PRELOAD, ENTRY, "start"], {
        env: envFor(home, { EGRESS_LOG: log, ACP_PORT: String(proxyPort), ACP_UPSTREAM: `http://127.0.0.1:${upPort}`, ACP_HOST: "127.0.0.1" }),
        stdio: "ignore",
    });
    try {
        let up = false;
        for (let i = 0; i < 60 && !up; i++) {
            await new Promise((r) => setTimeout(r, 500));
            up = await fetch(`http://127.0.0.1:${proxyPort}/__bili/health`).then(() => true, () => false);
        }
        assert.ok(up, "proxy did not come up");
        const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "test", "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "m", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }) });
        assert.ok(r.status < 500, `request through proxy failed: ${r.status}`);
        assert.ok(upstreamHits.length > 0, "the model request never reached the configured upstream");
        // outlive every background timer the upstream build starts (first watcher check at 10-15 s)
        await new Promise((r) => setTimeout(r, 17_000));
    } finally {
        child.kill();
        upstream.close();
    }
    const events = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    assert.ok(events.some((e) => e.kind === "connect" && LOOPBACK.has(e.host) && Number(e.port) === upPort), `preload never saw the upstream connect (blind check): ${JSON.stringify(events.slice(0, 8))}`);
    const badConnect = events.filter((e) => e.kind === "connect" && e.host && e.host !== "(path)" && !LOOPBACK.has(e.host));
    const badDns = events.filter((e) => e.kind === "dns" && !LOOPBACK.has(e.host));
    const badSpawn = events.filter((e) => e.kind === "spawn" && /\b(npm|npx|pnpm|git|curl|wget)\b/i.test(`${e.cmd} ${(e.args ?? []).join(" ")}`));
    assert.deepEqual(badConnect, [], "non-loopback connects");
    assert.deepEqual(badDns, [], "non-loopback DNS lookups");
    assert.deepEqual(badSpawn, [], "package-manager / network tool spawns");
});

test("egress preload sees a foreign fetch and foreign DNS (the check is not blind)", async () => {
    const home = freshHome();
    const log = join(home, "probe.jsonl");
    const code = "fetch('http://192.0.2.1:8080/',{signal:AbortSignal.timeout(1500)}).catch(()=>{});require('node:dns').promises.lookup('example.invalid').catch(()=>{});setTimeout(()=>{},2500)";
    spawnSync(process.execPath, ["--require", PRELOAD, "-e", code], { env: envFor(home, { EGRESS_LOG: log }), timeout: 15_000 });
    const events = existsSync(log) ? readFileSync(log, "utf8").trim().split(String.fromCharCode(10)).filter(Boolean).map((l) => JSON.parse(l)) : [];
    assert.ok(events.some((e) => e.kind === "connect" && e.host === "192.0.2.1"), `foreign connect not recorded: ${JSON.stringify(events)}`);
    assert.ok(events.some((e) => e.kind === "dns" && e.host === "example.invalid"), "foreign promises.lookup not recorded");
});

test("refuses to bind a non-loopback host", () => {
    const home = freshHome();
    const r = spawnSync(process.execPath, [ENTRY, "start", "--host", "0.0.0.0"], { env: envFor(home, { ACP_PORT: String(randPort()) }), encoding: "utf8", timeout: 20_000 });
    assert.notEqual(r.status, 0, `started on 0.0.0.0: ${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /loopback only/);
});

test("removed commands refuse and touch nothing", () => {
    for (const cmd of ["update", "claude", "plugin list", "mcp", "pack list"]) {
        const home = freshHome();
        const r = spawnSync(process.execPath, [ENTRY, ...cmd.split(" ")], { env: envFor(home, {}), encoding: "utf8", timeout: 20_000 });
        assert.equal(r.status, 2, `${cmd}: ${r.stdout}${r.stderr}`);
        assert.match(r.stderr, /removed in the AaaS fork/);
    }
});

test("update / advisory / announcement / policy fetch sites refuse", async () => {
    const { fetchRegistryVersion, startAutoUpdate } = await import("../src/update.js");
    await assert.rejects(() => fetchRegistryVersion({ updateTag: "latest" }, "billion-context"), /egress refused/);
    const { startAdvisoryWatcher } = await import("../src/advisory.js");
    const { startRemoteNoticesWatcher } = await import("../src/remote-notices.js");
    const { startReleaseNotesWatcher } = await import("../src/update-notes.js");
    // a started watcher would arm a timer
    const count = () => process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;
    const before = count();
    startAutoUpdate({ packageName: "x", currentVersion: "0.0.0", autoUpdate: true } as never);
    startAdvisoryWatcher({ packageName: "x", currentVersion: "0.0.0" } as never);
    startRemoteNoticesWatcher({} as never);
    startReleaseNotesWatcher({ packageName: "x", currentVersion: "0.0.0" } as never);
    assert.equal(count(), before, "a background watcher armed a timer");
});

test("config forces every remote feature off", async () => {
    const { loadOptions } = await import("../src/config.js");
    const o = loadOptions({ ...process.env, BILI_MITM: "1", ACP_AUTO_UPDATE: "1", BILI_ADVISORY_CHECK: "1", BILI_RELEASE_NOTES_CHECK: "1", BILI_ANNOUNCEMENTS_URL: "https://example.invalid/x.json" });
    assert.equal(o.autoUpdate, false);
    assert.equal(o.advisoryCheck, false);
    assert.equal(o.releaseNotesCheck, false);
    assert.equal(o.remoteAnnouncementsUrl, undefined);
    assert.equal(o.mitm.enabled, false);
    assert.throws(() => loadOptions({ ...process.env, ACP_HOST: "0.0.0.0" }), /loopback only/);
});
