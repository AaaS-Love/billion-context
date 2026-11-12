import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import {
    parseAdvisoryDoc,
    matchAdvisories,
    resolveAdvisoryUrl,
    runAdvisoryCheck,
    getAdvisoryState,
    evaluateAdvisories,
    describeAdvisory,
    _resetAdvisoryWatcherForTest,
    advisoryDeferring,
    advisoryBlocksVersion,
    advisoryAwaitingFirstCheck,
    _setAdvisoryWatcherStartedForTest,
    cannotResolveTarget,
    type AdvisoryEntry,
} from "../src/advisory.ts";
import { checkForUpdate, _resetAdvisoryRefusalWarnsForTest, _resetUpdateThrottleForTest } from "../src/update.ts";
import { setLogCapture } from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";

function integrityField(buf: Buffer, alg = "sha512"): string {
    return `${alg}-${crypto.createHash(alg).update(buf).digest("base64")}`;
}

interface Fixture {
    root: string;
    installDir: string;
    cacheDir: string;
    makeTarball(files: Record<string, string>): { tgz: Buffer; integrity: string };
}

/** A running install at 1.2.3 plus a scratch cache dir, like a real host. */
function makeFixture(): Fixture {
    const root = mkdtempSync(path.join(tmpdir(), "bc-advisory-test-"));
    const installDir = path.join(root, "install");
    const cacheDir = path.join(root, "cache");
    mkdirSync(path.join(installDir, "dist"), { recursive: true });
    writeFileSync(
        path.join(installDir, "package.json"),
        JSON.stringify({ name: "billion-context", version: "1.2.3", type: "module", main: "dist/index.js", bin: { bili: "./dist/index.js" } }),
    );
    writeFileSync(path.join(installDir, "dist", "index.js"), "export const loaded = '1.2.3';\n");
    return {
        root,
        installDir,
        cacheDir,
        makeTarball(files) {
            const src = path.join(root, "pkg");
            mkdirSync(path.join(src, "package"), { recursive: true });
            for (const [rel, body] of Object.entries(files)) {
                const dest = path.join(src, "package", rel);
                mkdirSync(path.dirname(dest), { recursive: true });
                writeFileSync(dest, body);
            }
            const tgzPath = path.join(root, "pkg.tgz");
            tar.c({ cwd: src, file: tgzPath, gzip: true, sync: true }, ["package"]);
            const tgz = readFileSync(tgzPath);
            return { tgz, integrity: integrityField(tgz) };
        },
    };
}

function pkgJson(version: string): string {
    return JSON.stringify({ name: "billion-context", version, type: "module", main: "dist/index.js", bin: { bili: "./dist/index.js" } });
}

function advisoryDoc(entries: unknown[]): Record<string, unknown> {
    return { name: "billion-context-advisories", version: "0.0.2", billionContextAdvisories: { schema: 1, updated: "2026-09-27", advisories: entries } };
}

/** Route global fetch by URL regex; every unmatched URL fails loudly. Returns the fetch count. */
async function withFetch(routes: Array<{ match: RegExp; body: unknown }>, fn: () => Promise<void>): Promise<number> {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = ((url: string | URL | Request) => {
        calls++;
        const u = String(url);
        for (const route of routes) {
            if (route.match.test(u)) {
                return Promise.resolve(new Response(typeof route.body === "string" || route.body instanceof Buffer ? route.body : JSON.stringify(route.body)));
            }
        }
        return Promise.reject(new Error(`unexpected fetch: ${u}`));
    }) as unknown as typeof fetch;
    try {
        await fn();
    } finally {
        globalThis.fetch = original;
    }
    return calls;
}

test("parseAdvisoryDoc: valid document extracts entries", () => {
    const r = parseAdvisoryDoc(
        advisoryDoc([
            { id: "bc-2026-001", affected: ">=0.1.155 <0.1.158", target: "0.1.157", reason: "breaks retries", publishedAt: "2026-09-27T00:00:00Z" },
        ]),
    );
    assert.equal(r.error, undefined);
    assert.deepEqual(r.entries, [{ id: "bc-2026-001", affected: ">=0.1.155 <0.1.158", target: "0.1.157", reason: "breaks retries", publishedAt: "2026-09-27T00:00:00Z" }]);
});

test("parseAdvisoryDoc: empty advisories list is clean (not an error)", () => {
    const r = parseAdvisoryDoc(advisoryDoc([]));
    assert.equal(r.error, undefined);
    assert.deepEqual(r.entries, []);
});

test("parseAdvisoryDoc: rejects wrong shape, wrong schema, missing field", () => {
    assert.match(parseAdvisoryDoc(["nope"]).error ?? "", /not a JSON object/);
    assert.match(parseAdvisoryDoc(null).error ?? "", /not a JSON object/);
    assert.match(parseAdvisoryDoc({}).error ?? "", /missing billionContextAdvisories/);
    assert.match(parseAdvisoryDoc({ billionContextAdvisories: { schema: 2, advisories: [] } }).error ?? "", /unsupported schema 2/);
    assert.match(parseAdvisoryDoc({ billionContextAdvisories: { schema: 1 } }).error ?? "", /advisories field is not an array/);
});

test("parseAdvisoryDoc: skips malformed entries, errors when none survive", () => {
    const good = { id: "ok-1", affected: ">=1.0.0", target: "1.0.1", reason: "r" };
    const bad = [
        { affected: ">=1.0.0", target: "1.0.1", reason: "r" },
        { id: "x", target: "1.0.1", reason: "r" },
        { id: "x", affected: ">=1.0.0", target: "not-a-version", reason: "r" },
        { id: "x", affected: ">=1.0.0", target: "1.0.1" },
        "garbage",
    ];
    const mixed = parseAdvisoryDoc(advisoryDoc([...bad, good]));
    assert.equal(mixed.error, undefined);
    assert.deepEqual(mixed.entries, [good]);
    const allBad = parseAdvisoryDoc(advisoryDoc(bad));
    assert.match(allBad.error ?? "", /no valid advisories/);
});

test("matchAdvisories: range, prerelease inclusion, fail-open on garbage", () => {
    const entries: AdvisoryEntry[] = [{ id: "a", affected: ">=0.1.155 <0.1.158", target: "0.1.157", reason: "r" }];
    assert.equal(matchAdvisories(entries, "0.1.156").length, 1);
    assert.equal(matchAdvisories(entries, "0.1.156-dev.1").length, 1, "prerelease matches its release base's range");
    assert.equal(matchAdvisories(entries, "0.1.154").length, 0);
    assert.equal(matchAdvisories(entries, "0.1.158").length, 0);
    assert.equal(matchAdvisories([{ id: "b", affected: "definitely-not-a-range", target: "1.0.0", reason: "r" }], "1.0.1").length, 0, "invalid range fails open");
    assert.deepEqual(matchAdvisories(entries, "not-a-version"), []);
});

test("resolveAdvisoryUrl: explicit override wins, default is the companion package", () => {
    assert.equal(resolveAdvisoryUrl("  https://example.test/feed.json "), "https://example.test/feed.json");
    assert.ok(resolveAdvisoryUrl(undefined).endsWith("/billion-context-advisories/latest"));
    assert.ok(resolveAdvisoryUrl("   ").endsWith("/billion-context-advisories/latest"));
});

const EVAL_URL = "https://registry.test/billion-context-advisories/latest";

test("#1577: describeAdvisory renders id/version/reason + manual command; falls back to @latest when unresolvable", () => {
    const active = { id: "bc-2026-001", affected: ">=1.2.0", target: "1.2.9", reason: "corrupts tool-call arguments", currentVersion: "1.2.3" };
    const normal = describeAdvisory(active, undefined);
    assert.ok(normal.includes("[bc-2026-001] version 1.2.3 is affected (corrupts tool-call arguments)"), normal);
    assert.ok(normal.includes("npm install -g billion-context@1.2.9"), normal);
    assert.ok(!normal.includes("latest"), "no fallback note for a resolvable target");

    const unresolved = describeAdvisory(active, "cannot resolve 1.2.9 on the registry");
    assert.ok(unresolved.includes("npm install -g billion-context@latest"), unresolved);
    assert.ok(unresolved.includes("pinned target unresolvable"), unresolved);
});
