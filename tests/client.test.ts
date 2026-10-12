import { createServer, type Server } from "node:http";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServiceClient } from "../src/client.js";
import { VERSION } from "../src/contracts.js";

describe("private authenticated service client", () => {
  let dir: string;
  let server: Server;
  let url: string;
  let token: string;
  const descriptor = () => ({
    protocol: 1,
    version: VERSION,
    url,
    token,
    pid: process.pid,
  });
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "spillway-client-"));
    await chmod(dir, 0o700);
    token = randomBytes(32).toString("hex");
    server = createServer((request, response) => {
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      if (request.url?.endsWith("/error")) {
        response.writeHead(409);
        response.end(
          JSON.stringify({ error: { code: "busy", message: token } }),
        );
      } else if (request.url?.endsWith("/secret")) {
        response.writeHead(400);
        response.end(
          JSON.stringify({ error: { code: token, message: token } }),
        );
      } else if (request.url?.endsWith("/redirect")) {
        response.writeHead(302, { location: "http://127.0.0.1:1/" });
        response.end();
      } else if (request.url?.endsWith("/bad")) {
        response.end(JSON.stringify({ missing: true }));
      } else response.end(JSON.stringify({ data: { running: false } }));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing HTTP port");
    url = `http://127.0.0.1:${address.port}`;
    await writeFile(join(dir, "service.json"), JSON.stringify(descriptor()), {
      mode: 0o600,
    });
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  });
  it("sends bearer credentials and unwraps data", async () => {
    const client = new ServiceClient(dir);
    expect(await client.request("GET", "/api/v1/status")).toEqual({
      running: false,
    });
    expect(new URL(await client.dashboardUrl()).searchParams.get("token")).toBe(
      token,
    );
  });
  it("rejects incompatible versions and protocols before networking", async () => {
    for (const patch of [{ protocol: 2 }, { version: "99.0.0" }]) {
      await writeFile(
        join(dir, "service.json"),
        JSON.stringify({ ...descriptor(), ...patch }),
      );
      await expect(new ServiceClient(dir).descriptor()).rejects.toMatchObject({
        code: "incompatible_service",
      });
    }
  });
  it("refuses remote origins and addresses with credentials or paths", async () => {
    for (const unsafe of [
      "https://example.com",
      "http://localhost:7433",
      `${url}/api`,
      `${url}?secret=x`,
      "http://user:pass@127.0.0.1:7433",
    ]) {
      await writeFile(
        join(dir, "service.json"),
        JSON.stringify({ ...descriptor(), url: unsafe }),
      );
      await expect(new ServiceClient(dir).descriptor()).rejects.toMatchObject({
        code: "invalid_descriptor",
      });
    }
  });
  it("refuses permissive files, directories and descriptor symlinks", async () => {
    await chmod(join(dir, "service.json"), 0o644);
    await expect(new ServiceClient(dir).descriptor()).rejects.toMatchObject({
      code: "unsafe_descriptor",
    });
    await chmod(join(dir, "service.json"), 0o600);
    await chmod(dir, 0o755);
    await expect(new ServiceClient(dir).descriptor()).rejects.toMatchObject({
      code: "unsafe_descriptor",
    });
    await chmod(dir, 0o700);
    await rm(join(dir, "service.json"));
    await writeFile(join(dir, "other.json"), JSON.stringify(descriptor()), {
      mode: 0o600,
    });
    await symlink(join(dir, "other.json"), join(dir, "service.json"));
    await expect(new ServiceClient(dir).descriptor()).rejects.toMatchObject({
      code: "invalid_descriptor",
    });
  });
  it("does not follow redirects or echo service-controlled secrets", async () => {
    const client = new ServiceClient(dir);
    await expect(
      client.request("GET", "/api/v1/redirect"),
    ).rejects.toMatchObject({ code: "service_unavailable" });
    await expect(client.request("GET", "/api/v1/error")).rejects.toMatchObject({
      code: "busy",
      message: "Service request failed (409, busy).",
    });
    await expect(client.request("GET", "/api/v1/secret")).rejects.toMatchObject(
      {
        code: "service_error",
        message: "Service request failed (400, service_error).",
      },
    );
    await expect(client.request("GET", "/api/v1/bad")).rejects.toMatchObject({
      code: "invalid_response",
    });
    await expect(
      client.request("GET", "//example.com/path"),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
  it("reports a missing service without exposing filesystem details", async () => {
    await rm(join(dir, "service.json"));
    await expect(new ServiceClient(dir).descriptor()).rejects.toMatchObject({
      code: "service_unavailable",
    });
  });
});
