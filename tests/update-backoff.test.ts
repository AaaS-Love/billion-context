import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// #1603 Defect 2: a persistently failing install must back off instead of
// re-downloading every 3-min cycle forever (pre-fix field behavior: 124× over 12
// days, no backoff/remediation). These pin the bounded-retry fix.
//
// CHECK_INTERVAL_MS / THROTTLE_FILE / LOCK_FILE are module-level consts frozen
// at import time, so the cache-dir override and the shrunk check cadence MUST be
// set before dynamically importing src/update.ts (a static import would hoist
// above them). Cadence = 1ms so repeated cycles don't wait 3 minutes.
const root = mkdtempSync(path.join(tmpdir(), "bc-backoff-test-"));
process.env.XDG_CACHE_HOME = path.join(root, "cache");
process.env.BILI_UPDATE_CHECK_INTERVAL_MS = "1";
// #3619: this suite pins backoff mechanics, not rollout timing — keep legacy
// immediate upgrades (stagger 0/0) and an unroutable policy URL so no cycle
// depends on external network state.
process.env.BILI_UPDATE_STAGGER_MIN_MS = "0";
process.env.BILI_UPDATE_STAGGER_MAX_MS = "0";
process.env.BILI_UPDATE_POLICY_URL = "http://127.0.0.1:1/no-policy.json";
const { checkForUpdate, backoffMs, _resetInstallBackoffForTest } = await import("../src/update.ts");
const { setLogCapture } = await import("../src/logger.ts");

test("backoffMs grows exponentially from the base and caps at 6h", () => {
    const min = 60_000;
    assert.equal(backoffMs(3), 5 * min);
    assert.equal(backoffMs(4), 10 * min);
    assert.equal(backoffMs(5), 20 * min);
    assert.equal(backoffMs(6), 40 * min);
    // sub-threshold counts clamp to the base (never applied as a cooldown)
    assert.equal(backoffMs(1), 5 * min);
    assert.equal(backoffMs(2), 5 * min);
    assert.equal(backoffMs(50), 6 * 60 * min);
    assert.equal(backoffMs(1_000_000), 6 * 60 * min);
});

function registryDoc(version: string): object {
    return {
        version,
        dist: {
            tarball: `https://registry.test/${version}.tgz`,
            integrity: "sha512-" + "a".repeat(64),
            shasum: "b".repeat(40),
        },
    };
}

