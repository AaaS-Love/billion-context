// #2192: the owner-managed update lanes (dsh desktop in-place copy, dsh profile
// bundles, pi npm copy) bypassed the #1603 InstallBackoff — a persistently
// failing lane retried every check cycle forever, and the desktop lane
// re-downloaded its full tarball on every attempt (~480×/day at the default
// cadence). These pin the fix:
//   (a) a failing desktop refresh is a no-op inside the backoff window — no
//       registry call, no download;
//   (b) success resets the lane's key;
//   (c) profile/pi lanes get the same bounded retry with their existing
//       behavior preserved, keyed per lane+version;
//   (d) host-managed instances throttle on their own marker file with the
//       slower owner-lane cadence instead of the global 3-min one.
//
// THROTTLE_FILE / LOCK_FILE / OWNER_THROTTLE_FILE are module-level consts
// frozen at import time, so the cache-dir override MUST be set before
// dynamically importing src/update.ts (same discipline as
// update-backoff.test.ts).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync } from "node:fs";
import crypto from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import type { PiPlan } from "../src/pi-channel.ts";
import type { DshPlan } from "../src/dsh-channel.ts";
import { rmrf } from "./tmp-rm.ts";

const root = mkdtempSync(path.join(tmpdir(), "bc-owner-lane-backoff-"));
process.env.XDG_CACHE_HOME = path.join(root, "cache");
// #3619: the profile/pi lanes now pass through the update-policy gate before
// the backoff logic — stagger 0/0 + an unroutable policy URL keep this suite
// hermetic (same discipline as update-dsh-self-refresh.test.ts).
process.env.BILI_UPDATE_STAGGER_MIN_MS = "0";
process.env.BILI_UPDATE_STAGGER_MAX_MS = "0";
process.env.BILI_UPDATE_POLICY_URL = "http://127.0.0.1:1/no-policy.json";

const {
    refreshDshDesktopCopy,
    refreshPiNpmCopy,
    convergeDshProfileBundles,
    checkForUpdate,
    _resetInstallBackoffForTest,
    _resetUpdateThrottleForTest,
    _installBackoffStateForTest,
    _backoffCooldownForTest,
    _reloadBackoffsForTest,
    clearOwnerLaneBackoff,
    ownerLaneKey,
    ownerLaneIntervalMs,
} = await import("../src/update.ts");
const { _setPiRunnersForTest } = await import("../src/pi-channel.ts");
const { _setDshRunnersForTest } = await import("../src/dsh-channel.ts");
const { setLogCapture } = await import("../src/logger.ts");

after(() => {
    delete process.env.XDG_CACHE_HOME;
    delete process.env.BILI_UPDATE_STAGGER_MIN_MS;
    delete process.env.BILI_UPDATE_STAGGER_MAX_MS;
    delete process.env.BILI_UPDATE_POLICY_URL;
    rmrf(root);
});

// — shared fixtures (shapes mirrored from update-desktop-inplace.test.ts) ————

function integrityField(buf: Buffer, alg = "sha512"): string {
    return `${alg}-${crypto.createHash(alg).update(buf).digest("base64")}`;
}

/** The laid-down package's dist/index.js. The stock form boots clean under
 *  the boot smoke; pass something that exits non-zero to make
 *  installViaTarball fail AFTER the full download (the bandwidth-burning
 *  failure shape from the field repro). */
function writePkg(dir: string, version: string, entry: string = `export const loaded = '${version}';\n`): void {
    mkdirSync(path.join(dir, "dist"), { recursive: true });
    writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "billion-context", version, type: "module", main: "dist/index.js", bin: { bili: "./dist/index.js" } }),
    );
    writeFileSync(path.join(dir, "dist", "index.js"), entry);
}

function makePnpmLink(target: string, linkPath: string): void {
    symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

interface DesktopFixture { dshHome: string; flat: string; tgz: Buffer; }

function buildDesktopFixture(base: string, storeVersion: string, tarballVersion: string, entry?: string): DesktopFixture {
    const dshHome = path.join(base, "dsh-home");
    const profileDir = path.join(dshHome, "profiles", "desktop");
    const storeCopy = path.join(profileDir, ".pnpm", `billion-context@${storeVersion}`, "node_modules", "billion-context");
    const flat = path.join(profileDir, "node_modules", "billion-context");
    writePkg(storeCopy, storeVersion);
    mkdirSync(path.join(profileDir, "node_modules"), { recursive: true });
    makePnpmLink(storeCopy, flat);
    const src = path.join(base, "pkg", "package");
    writePkg(src, tarballVersion, entry);
    const tgzPath = path.join(base, "pkg.tgz");
    tar.c({ cwd: path.join(base, "pkg"), file: tgzPath, gzip: true, sync: true }, ["package"]);
    return { dshHome, flat, tgz: readFileSync(tgzPath) };
}

function stubRegistryFetch(tgz: Buffer, tarballUrl: string, version: string, integrity: string, hits: { count: number }): void {
    globalThis.fetch = ((url: unknown) => {
        hits.count += 1;
        const u = String(url);
        if (u.endsWith(`/billion-context/${version}`)) {
            return Promise.resolve(new Response(JSON.stringify({ dist: { tarball: tarballUrl, integrity } }), { headers: { "content-type": "application/json" } }));
        }
        if (u === tarballUrl) {
            return Promise.resolve(new Response(tgz));
        }
        return Promise.reject(new Error(`unexpected fetch in test: ${u}`));
    }) as unknown as typeof fetch;
}

type CaptureLog = (level: string, msg: string) => void;

/** Taps both logging channels into one array: the injected log param AND the
 * module-level loggerLog via setLogCapture — recordInstallFailure reports
 * through loggerLog, not the injected log, so backoff streak/escalation lines
 * only land there. */
function captureAll(): { lines: string[]; log: CaptureLog } {
    const lines: string[] = [];
    const log: CaptureLog = (level, msg) => { lines.push(`${level}: ${msg}`); };
    setLogCapture((_level, msg) => { lines.push(msg); });
    return { lines, log };
}

// — (a)+(b) desktop lane —————————————————————————————————————————————————————————



// — (c) profile + pi lanes —————————————————————————————————————————————————————


// — (d2) mixed outcome pins the lane semantics: ANY failed profile is a strike (#2192)

test("a partial failure (some profiles refreshed, one broken) still records a lane strike (#2192)", { timeout: 60_000 }, async (t) => {
    await _resetInstallBackoffForTest();
    const base = mkdtempSync(path.join(root, "t4b-"));
    t.after(() => {
        setLogCapture(null);
        _setDshRunnersForTest(undefined);
        rmrf(base);
    });
    const dshHome = path.join(base, "dsh");
    for (const name of ["a", "b"]) {
        const pDir = path.join(dshHome, "profiles", name);
        const install = path.join(pDir, "node_modules", "billion-context");
        mkdirSync(install, { recursive: true });
        writeFileSync(path.join(pDir, "package.json"), JSON.stringify({ private: true, dependencies: { "billion-context": "^1.0.0" } }));
        writeFileSync(path.join(install, "package.json"), JSON.stringify({ name: "billion-context", version: "1.0.0" }));
    }
    const env = { ...process.env, DSH_HOME: dshHome };
    const calls: string[] = [];
    const failingFor = (broken: string) => async (plan: DshPlan) => {
        // windows wraps the whole invocation into one cmd.exe line token
        // (planDshSpawn → ["/d","/s","/c","\"…dsh.cmd\" plugin --profile b …"]),
        // so match on the joined string instead of indexing the args array
        const joined = plan.args.join(" ");
        const m = /--profile (\S+)/.exec(joined);
        const target = m?.[1] ?? "?";
        calls.push(`${target}:${joined}`);
        if (target === broken) throw Object.assign(new Error("exit 1"), { status: 1, stderr: "plugin channel down" });
        // #5642: a clean exit leaves the requested copy readable — mirror that,
        // otherwise the post-op verification counts every "success" as a broken
        // op and strikes the lane on its own
        if (m) {
            const install = path.join(dshHome, "profiles", target, "node_modules", "billion-context");
            mkdirSync(install, { recursive: true });
            writeFileSync(path.join(install, "package.json"), JSON.stringify({ name: "billion-context", version: "2.0.0" }));
        }
        return { stdout: "", stderr: "" };
    };
    try {
        const { log } = captureAll();
        const key = ownerLaneKey("dsh-profile", "2.0.0");
        _setDshRunnersForTest({ async: failingFor("b") });

        // converge #1: profile a converges, b fails — a PARTIAL failure must
        // still count as a lane strike (runProfileBundlesRefresh strikes on any
        // res.failed > 0; the PR-body claim "partial success → no strike" was
        // wrong and this test pins the shipped semantics).
        await convergeDshProfileBundles("/nonexistent", "2.0.0", env, log);
        assert.equal(calls.length, 2, `both profiles attempted once: ${calls.join(" | ")}`);
        assert.equal(_installBackoffStateForTest()[key]?.count, 1, "a partial failure (1 of 2 profiles) records a strike");

        // strikes accumulate the same way as total failures; third strike arms.
        // (a converged to 2.0.0 in pass #1 and is in-step-skipped since — #1803 —
        // so passes #2/#3 spawn only for still-stale b.)
        await convergeDshProfileBundles("/nonexistent", "2.0.0", env, log);
        await convergeDshProfileBundles("/nonexistent", "2.0.0", env, log);
        assert.equal(_installBackoffStateForTest()[key]?.count, 3, "third partial failure arms the cooldown");
        // once armed the whole lane is gated — even the still-stale profile b stops spawning
        await convergeDshProfileBundles("/nonexistent", "2.0.0", env, log);
        assert.equal(calls.length, 4, "an armed lane must not spawn for ANY profile, stale ones included");

        // manual disarm + repairing b lets the lane run again and a clean pass clears the key
        await clearOwnerLaneBackoff("dsh-profile", "2.0.0");
        _setDshRunnersForTest({ async: failingFor("none") });
        await convergeDshProfileBundles("/nonexistent", "2.0.0", env, log);
        assert.equal(calls.length, 5, "a disarmed, repaired lane attempts the remaining stale profile (a is in-step)");
        assert.equal(_installBackoffStateForTest()[key], undefined, "a clean run clears the lane key");
    } finally {
        _setDshRunnersForTest(undefined);
    }
});


// — (d) host-managed throttle marker ———————————————————————————————————————————


test("ownerLaneIntervalMs: 10 min floor, 5 min jitter ceiling (#2192, owner cadence call 2026-10-07)", () => {
    assert.equal(ownerLaneIntervalMs(() => 0), 10 * 60_000);
    assert.equal(ownerLaneIntervalMs(() => 1), 15 * 60_000);
    assert.equal(ownerLaneIntervalMs(() => 0.5), 12 * 60_000 + 30_000);
});

// — (e) cross-process streak sharing + manual-repair disarm (#2192 follow-up) —

function stateFilePath(): string {
    return path.join(process.env.XDG_CACHE_HOME!, "billion-context", ".install-backoff.json");
}

function readStateFile(): { entries: Record<string, { count: number; nextRetryAt: number }> } {
    return JSON.parse(readFileSync(stateFilePath(), "utf-8")) as { entries: Record<string, { count: number; nextRetryAt: number }> };
}

test("streaks are shared across bili processes via the cache-dir state file; a manual fix disarms immediately (#2192)", { timeout: 60_000 }, async (t) => {
    await _resetInstallBackoffForTest();
    const base = mkdtempSync(path.join(root, "t5-"));
    t.after(() => {
        setLogCapture(null);
        _setDshRunnersForTest(undefined);
        rmrf(base);
    });
    const dshHome = path.join(base, "dsh");
    const aDir = path.join(dshHome, "profiles", "a");
    const installDir = path.join(aDir, "node_modules", "billion-context");
    mkdirSync(installDir, { recursive: true });
    writeFileSync(path.join(aDir, "package.json"), JSON.stringify({ private: true, dependencies: { "billion-context": "^1.0.0" } }));
    writeFileSync(path.join(installDir, "package.json"), JSON.stringify({ name: "billion-context", version: "1.0.0" }));
    const env = { ...process.env, DSH_HOME: dshHome };

    const calls: string[] = [];
    const failing = async (plan: DshPlan) => {
        calls.push(plan.args.join(" "));
        throw Object.assign(new Error("exit 1"), { status: 1, stderr: "plugin channel down" });
    };
    const healthy = async (plan: DshPlan) => {
        calls.push(plan.args.join(" "));
        // #5642: a clean exit leaves the requested copy readable — mirror that,
        // otherwise the post-op verification counts the "healthy" run as a broken
        // op and records a strike instead of clearing the key
        mkdirSync(installDir, { recursive: true });
        writeFileSync(path.join(installDir, "package.json"), JSON.stringify({ name: "billion-context", version: "2.0.0" }));
        return { stdout: "", stderr: "" };
    };
    try {
        _setDshRunnersForTest({ async: failing });
        const { log } = captureAll();
        const key = ownerLaneKey("dsh-profile", "2.0.0");

        // arm the cooldown (3 strikes) in "process one"
        for (let i = 0; i < 3; i++) await convergeDshProfileBundles("/nonexistent", "2.0.0", env, log);
        assert.equal(calls.length, 3);
        assert.equal(_installBackoffStateForTest()[key]?.count, 3, "third strike arms the cooldown");
        assert.ok(existsSync(stateFilePath()), "armed cooldown must be persisted to the cache-dir state file");
        assert.equal(readStateFile().entries[key]?.count, 3, "the state file carries the armed streak");

        // "process two" — fresh in-memory map, same state file on disk — honors
        // the cooldown written by process one (pre-fix: k instances each burned
        // their own 3-strike budget, multiplying the retry rate k×).
        _reloadBackoffsForTest();
        await convergeDshProfileBundles("/nonexistent", "2.0.0", env, log);
        assert.equal(calls.length, 3, "a fresh process must honor the shared cooldown — no 4th spawn");

        // a successful manual repair (`bili plugin update`) disarms the lane
        // immediately instead of waiting out the ≤6 h window
        await clearOwnerLaneBackoff("dsh-profile", "2.0.0");
        assert.equal(_installBackoffStateForTest()[key], undefined, "manual clear wipes the armed entry");
        _reloadBackoffsForTest();
        await convergeDshProfileBundles("/nonexistent", "2.0.0", env, log);
        assert.equal(calls.length, 4, "disarmed lane attempts again");

        // and a healthy run clears the streak for good — the state file drops
        // the key once nothing is cooling down
        _setDshRunnersForTest({ async: healthy });
        await convergeDshProfileBundles("/nonexistent", "2.0.0", env, log);
        assert.equal(calls.length, 5);
        const persisted = existsSync(stateFilePath()) ? readStateFile().entries[key] : undefined;
        assert.equal(persisted, undefined, "success must drop the key from the state file");
    } finally {
        _setDshRunnersForTest(undefined);
    }
});

// — (f) the state file can never silence a lane (#2192 follow-up) —

