// Test-only preload: records every socket connect, DNS lookup and child process
// of the proxy under test, so tests/aaas-local-only.test.ts can assert that no
// destination other than loopback was ever touched.
const fs = require("node:fs");
const net = require("node:net");
const dns = require("node:dns");
const cp = require("node:child_process");
const out = process.env.EGRESS_LOG;
const w = (o) => { try { fs.appendFileSync(out, JSON.stringify(o) + "\n"); } catch {} };
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...a) {
  const o = a[0];
  if (o && typeof o === "object") w({ kind: "connect", host: o.host ?? "(path)", port: o.port, path: o.path });
  else if (typeof o === "number") w({ kind: "connect", host: typeof a[1] === "string" ? a[1] : "localhost", port: o });
  else if (typeof o === "string") w({ kind: "connect", host: "(path)", path: o });
  return origConnect.apply(this, a);
};
const origLookup = dns.lookup;
dns.lookup = function (host, ...r) { w({ kind: "dns", host }); return origLookup.call(this, host, ...r); };
for (const fn of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync"]) {
  const orig = cp[fn];
  cp[fn] = function (cmd, ...r) { w({ kind: "spawn", cmd: String(cmd), args: Array.isArray(r[0]) ? r[0].map(String) : [] }); return orig.call(this, cmd, ...r); };
}
