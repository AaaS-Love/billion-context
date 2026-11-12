/**
 * AaaS fork: this build makes NO outbound request of its own. The only network
 * traffic is the proxied model API call the operator configured. Everything
 * upstream used for self-update, advisories, release notes, remote
 * announcements and update policy is cut at its fetch site by calling
 * refuseEgress(); the periodic watchers never start (see the start* functions).
 * tests/no-egress.test.ts proves it with a socket-level check.
 */
export class EgressRefusedError extends Error {
    constructor(what: string) {
        super(`egress refused (AaaS fork is local-only): ${what}`);
        this.name = "EgressRefusedError";
    }
}

export function refuseEgress(what: string): never {
    throw new EgressRefusedError(what);
}

/** The proxy only ever listens on loopback. */
export function isLoopbackHost(host: string): boolean {
    const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
    return h === "127.0.0.1" || h === "::1" || h === "localhost" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

export function assertLoopbackBind(host: string): void {
    if (!isLoopbackHost(host)) {
        throw new Error(`refusing to bind ${host}: this build listens on loopback only (127.0.0.1 / ::1)`);
    }
}
