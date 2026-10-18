const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, execFile } = require("node:child_process");
const { promisify } = require("node:util");

// Ephemeral private PKI: no committed private keys or certificate-expiry dates.
function certificates(dir) {
  const run = (...args) =>
    execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  fs.writeFileSync(
    path.join(dir, "ca.cnf"),
    "[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=MCP isolated test CA\n[ca]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\n",
  );
  for (const name of ["trusted", "untrusted"]) {
    run(
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-config",
      "ca.cnf",
      "-keyout",
      `${name}.key`,
      "-out",
      `${name}.pem`,
    );
  }
  for (const [name, ca, san] of [
    ["ip", "trusted", "DNS:localhost,IP:127.0.0.1"],
    ["dns", "trusted", "DNS:localhost"],
    ["untrusted-server", "untrusted", "DNS:localhost"],
  ]) {
    run(
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=localhost",
      "-keyout",
      `${name}.key`,
      "-out",
      `${name}.csr`,
    );
    fs.writeFileSync(
      path.join(dir, `${name}.ext`),
      `basicConstraints=CA:false\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`,
    );
    run(
      "x509",
      "-req",
      "-in",
      `${name}.csr`,
      "-CA",
      `${ca}.pem`,
      "-CAkey",
      `${ca}.key`,
      "-CAcreateserial",
      "-days",
      "1",
      "-extfile",
      `${name}.ext`,
      "-out",
      `${name}.pem`,
    );
  }
}

test(
  "real Signal K TLS/proxy hosting preserves routing, identity and certificate checks",
  { timeout: 120000 },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signalk-mcp-pki-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    certificates(dir);
    for (const topology of [
      "proxy",
      "native-ip",
      "native-dns",
      "name-mismatch",
      "untrusted",
      "configured-name-mismatch",
    ]) {
      await t.test(topology, async () => {
        // NODE_EXTRA_CA_CERTS is read at process startup. Do not alter global TLS
        // defaults or use NODE_TLS_REJECT_UNAUTHORIZED=0, even in the tests.
        await promisify(execFile)(
          process.execPath,
          [path.join(__dirname, "hosting-fixture.cjs"), topology, dir],
          {
            env: {
              ...process.env,
              NODE_EXTRA_CA_CERTS: path.join(dir, "trusted.pem"),
            },
            timeout: 30000,
            maxBuffer: 1024 * 1024,
          },
        );
      });
    }
  },
);
