import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof fs>();
  return { ...actual, mkdtemp: vi.fn(actual.mkdtemp) };
});
interface Assets { marketplace: Buffer; plugin: Map<string, Buffer> }
interface MarketplaceHelpers {
  parseArguments(args: string[]): { executable: string; remote: boolean };
  parseVersion(output: string): string;
  administrativeArguments(args: string[]): string[];
  cleanEnvironment(root: string): Record<string, string>;
  parsePluginList(output: string, enabled: boolean | null, root: string): { installPath: string } | undefined;
  parseReceipt(output: string, command: string): void;
  marketplaceAssets(path: string): Promise<Assets>;
  matchingAssets(source: Map<string, Buffer>, installed: Map<string, Buffer>): void;
  boundedCommand(program: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout?: number): Promise<string>;
  runMarketplaceSmoke(args: string[]): Promise<number>;
}
const script = resolve("scripts/marketplace-smoke.mjs"), checkout = resolve(".");
const execute = promisify(execFile);
let smoke: MarketplaceHelpers;
beforeAll(async () => { smoke = await import(pathToFileURL(script).href) as MarketplaceHelpers; });
describe("isolated administrative marketplace smoke (fake vendor only)", () => {
  let root: string, original: typeof fs;
  beforeEach(async () => {
    original = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.mkdtemp).mockImplementation(original.mkdtemp);
    root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "spillway-marketplace-tests-")));
    await fs.chmod(root, 0o700);
  });
  afterEach(async () => {
    vi.restoreAllMocks(); vi.mocked(fs.mkdtemp).mockImplementation(original.mkdtemp);
    await fs.rm(root, { recursive: true, force: true });
  });
  it.each([[], ["--claude"], ["--claude", "relative"], ["--claude", "/absolute", "--source", "https://private.invalid"],
    ["--claude", "/absolute", "--public-source", "extra"], ["--claude", "/absolute\nprivate"]].map(args => ({ args })))(
    "rejects malformed arguments $args with fixed errors", ({ args }) => {
      expect(() => smoke.parseArguments(args)).toThrow("Administrative marketplace verification refused.");
    },
  );
  it("permits only explicit executable plus boolean fixed-public-source mode", () => {
    expect(smoke.parseArguments(["--claude", "/absolute"])).toEqual({ executable: "/absolute", remote: false });
    expect(smoke.parseArguments(["--claude", "/absolute", "--public-source"])).toEqual({ executable: "/absolute", remote: true });
  });
  it.each(["2.1.295 (Claude Code)", "2.1.296", "2.1.296 (Claude Code) private", "private2.1.296 (Claude Code)"])(
    "refuses unsupported or ambiguous version output", output => { expect(() => smoke.parseVersion(output)).toThrow(); },
  );
  it.each([["-p", "prompt"], ["auth", "login"], ["mcp", "list"], ["plugin", "eval", "spillway"],
    ["plugin", "marketplace", "add", "https://private.invalid", "--scope", "user", "--json"],
    ["plugin", "install", "foreign@agent-spillway", "--scope", "user", "--json"],
    ["plugin", "install", "spillway@agent-spillway", "--scope", "project", "--json"]].map(args => ({ args })))(
    "refuses nonadministrative, arbitrary-source or non-user-scope commands $args", ({ args }) => {
      expect(() => smoke.administrativeArguments(args)).toThrow();
    },
  );
  it("builds a closed child environment without inherited account or provider variables", () => {
    const env = smoke.cleanEnvironment(root);
    expect(Object.keys(env).some(name => /API_KEY|TOKEN|AUTH_TOKEN|NPM_CONFIG|NODE_OPTIONS|SSH_AUTH_SOCK/.test(name))).toBe(false);
    for (const name of ["HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TMPDIR"])
      expect(env[name]!.startsWith(root)).toBe(true);
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null"); expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_CONFIG_VALUE_0).toBe(""); expect(env.GIT_CONFIG_VALUE_1).toBe("/dev/null");
    expect(env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL).toBe("1");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
  });
  it("rejects malformed administrative receipts/list identity and mismatching asset bytes", () => {
    expect(() => smoke.parseReceipt('{"command":"install","outcome":"error"}', "install")).toThrow();
    expect(() => smoke.parseReceipt("not json", "install")).toThrow();
    expect(() => smoke.parsePluginList('{"id":"spillway"}', true, root)).toThrow();
    expect(() => smoke.parsePluginList("[]", true, root)).toThrow();
    const item = { id: "spillway@agent-spillway", version: "0.0.0", scope: "user", enabled: true,
      installPath: "/outside", mcpServers: { spillway: { command: "spillway", args: ["mcp"] } } };
    expect(() => smoke.parsePluginList(JSON.stringify([item]), true, root)).toThrow();
    expect(() => smoke.matchingAssets(new Map([["asset", Buffer.from("public")]]), new Map([["asset", Buffer.from("tampered")]]))).toThrow();
  });
  it("refuses a symlinked marketplace manifest directory without reading/adopting its foreign content", async () => {
    const snapshot = join(root, "snapshot"), foreign = join(root, "foreign");
    await fs.mkdir(snapshot); await fs.mkdir(foreign, { mode: 0o755 });
    const file = join(foreign, "marketplace.json"); await fs.writeFile(file, "synthetic-private-marker", { mode: 0o644 });
    await fs.symlink(foreign, join(snapshot, ".claude-plugin"));
    await expect(smoke.marketplaceAssets(snapshot)).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe("synthetic-private-marker");
    expect((await fs.lstat(foreign)).mode & 0o777).toBe(0o755);
  });
  async function fakeVendor(mode: string) {
    const executable = join(root, "claude-" + mode), log = join(root, "commands-" + mode + ".jsonl");
    await fs.writeFile(executable, `#!${process.execPath}\nconst mode=${JSON.stringify(mode)},log=${JSON.stringify(log)},checkout=${JSON.stringify(checkout)};\n` + String.raw`
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');const args=process.argv.slice(2),config=process.env.CLAUDE_CONFIG_DIR,home=process.env.HOME;
fs.appendFileSync(log,JSON.stringify({args,cwd:process.cwd(),envKeys:Object.keys(process.env),home,config,tmp:process.env.TMPDIR,nonessential:process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC})+'\n');
if(args[0]==='--version'){console.log(mode==='version'?'2.1.295 (Claude Code)':'2.1.296 (Claude Code)');process.exit(0)}
const plugins=path.join(config,'plugins'),statePath=path.join(config,'fake-state.json'),knownPath=path.join(plugins,'known_marketplaces.json'),installedPath=path.join(plugins,'installed_plugins.json');fs.mkdirSync(plugins,{recursive:true,mode:0o700});
let state=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath)):{};
const save=()=>fs.writeFileSync(statePath,JSON.stringify(state),{mode:0o600});
const receipt=command=>{let obj=command.startsWith('marketplace-')?{command,outcome:'ok',marketplace:'agent-spillway',message:'synthetic-private-response-marker'}:{command,outcome:'ok',plugin:'spillway@agent-spillway',pluginId:'spillway@agent-spillway',scope:'user',message:'synthetic-private-response-marker'};if(mode==='receipt'&&command==='install')obj.outcome='error';console.log(JSON.stringify(obj));};
if(args[1]==='validate'){console.log(mode==='validation'?'synthetic malformed validation':'✔ Validation passed');process.exit(0)}
if(args[1]==='marketplace'&&args[2]==='add'){
 let source=args[3],remote=source.startsWith('https:');
 if(remote){source=path.join(plugins,'marketplaces','agent-spillway');fs.mkdirSync(source,{recursive:true});fs.cpSync(path.join(checkout,'.claude-plugin'),path.join(source,'.claude-plugin'),{recursive:true});fs.cpSync(path.join(checkout,'plugins'),path.join(source,'plugins'),{recursive:true});
 const git=a=>cp.execFileSync('git',['-c','core.hooksPath=/dev/null','-C',source,...a],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']}).trim();git(['init','-q','--template=']);git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Public fixture assets']);git(['remote','add','origin',args[3]]);state.commit=git(['rev-parse','HEAD']);}
 state.source=source;state.remote=remote;fs.writeFileSync(knownPath,JSON.stringify({'agent-spillway':{source:remote?{source:'git',url:args[3]}:{source:'directory',path:source},installLocation:source}}),{mode:0o600});save();receipt('marketplace-add');process.exit(0)}
if(args[1]==='marketplace'&&args[2]==='remove'){if(mode!=='remove')fs.writeFileSync(knownPath,'{}');receipt('marketplace-remove');process.exit(0)}
if(args[1]==='install'){
 state.path=path.join(plugins,'cache','agent-spillway','spillway','0.0.0');fs.mkdirSync(state.path,{recursive:true});fs.cpSync(path.join(state.source,'plugins','spillway'),state.path,{recursive:true});state.enabled=true;state.installed=true;
 if(mode==='tamper')fs.appendFileSync(path.join(state.path,'skills','bank','SKILL.md'),'tampered');
 if(mode==='missing')fs.unlinkSync(path.join(state.path,'agents','auditor.md'));
 if(mode==='extra')fs.writeFileSync(path.join(state.path,'extra-private-file'),'synthetic-private-marker');
 if(mode==='permissions')fs.chmodSync(path.join(state.path,'scripts','session-start.sh'),0o600);
 if(mode==='symlink'){const file=path.join(state.path,'agents','auditor.md');fs.unlinkSync(file);fs.symlinkSync(path.join(checkout,'plugins','spillway','agents','auditor.md'),file);}
 if(mode==='invoke')cp.spawnSync('spillway',['mcp'],{env:process.env,timeout:2000});
 const row={scope:'user',installPath:state.path,version:'0.0.0',...(state.remote?{gitCommitSha:state.commit}:{})};fs.writeFileSync(installedPath,JSON.stringify({version:2,plugins:{'spillway@agent-spillway':[row]}}),{mode:0o600});save();receipt('install');process.exit(0)}
if(args[1]==='list'){
 if(mode==='list'&&state.installed){console.log('not json');process.exit(0)}
 const row={id:'spillway@agent-spillway',version:'0.0.0',scope:'user',enabled:state.enabled,installPath:state.path,mcpServers:{spillway:{command:'spillway',args:['mcp']}}};console.log(JSON.stringify(state.installed?[row]:[]));process.exit(0)}
if(args[1]==='disable'||args[1]==='enable'){if(mode!=='disable')state.enabled=args[1]==='enable';save();receipt(args[1]);process.exit(0)}
if(args[1]==='uninstall'){if(mode!=='uninstall'){state.installed=false;fs.writeFileSync(installedPath,JSON.stringify({version:2,plugins:{}}));}save();receipt('uninstall');process.exit(0)}
process.exit(3);
`, { mode: 0o700 });
    return { executable, log };
  }
  const run = async (executable: string, remote = false) => {
    try { const result = await execute(process.execPath, [script, "--claude", executable, ...(remote ? ["--public-source"] : [])], {
      env: { ...process.env, ANTHROPIC_API_KEY: "synthetic-inherited-private-marker", OPENAI_API_KEY: "synthetic-inherited-private-marker", CLAUDE_CONFIG_DIR: join(root, "operator-config"), HOME: root },
      timeout: 15000, maxBuffer: 4096,
    }); return { code: 0, ...result }; }
    catch (error) { const outcome = error as { code: number; stdout: string; stderr: string }; return outcome; }
  };
  it.each([false, true])("completes a fake administrative lifecycle with revision identity (public-source=%s), isolated env and cleaned home", async remote => {
    const { executable, log } = await fakeVendor(remote ? "public" : "local");
    const result = await run(executable, remote);
    expect(result.code).toBe(0); expect(result.stderr).toBe("");
    const receipt = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(receipt).toMatchObject({ version: 1, claudeVersion: "2.1.296", sourceKind: remote ? "public-main" : "current-snapshot", matchingAssets: true, lifecycle: true,
      unexpectedInvocations: 0, liveSession: false });
    expect(receipt.assetHash).toMatch(/^[a-f0-9]{64}$/);
    if (remote) expect(receipt.sourceCommit).toMatch(/^[a-f0-9]{40}$/); else expect(receipt.sourceCommit).toBeNull();
    expect(result.stdout).not.toContain("synthetic-private");
    const calls = (await fs.readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { args: string[]; cwd: string; envKeys: string[]; home: string; config: string; tmp: string; nonessential: string });
    for (const call of calls) {
      expect(() => smoke.administrativeArguments(call.args)).not.toThrow();
      expect(call.envKeys).not.toEqual(expect.arrayContaining(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "NODE_OPTIONS", "SSH_AUTH_SOCK"]));
      expect(call.nonessential).toBe("1");
      expect(call.home).not.toBe(root); expect(call.config).not.toBe(join(root, "operator-config"));
      expect(call.cwd.startsWith(call.tmp)).toBe(true);
      await expect(fs.lstat(call.tmp)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(calls.filter(call => call.args[1] === "list")).toHaveLength(5);
    expect(calls.map(call => call.args[1])).toEqual(expect.arrayContaining(["install", "disable", "enable", "uninstall"]));
  });
  it.each(["version", "validation", "receipt", "list", "tamper", "missing", "extra", "permissions", "symlink", "invoke", "disable", "uninstall", "remove"])(
    "fails closed for fake vendor %s regression and removes only temporary state", async mode => {
      const { executable, log } = await fakeVendor(mode);
      const sentinel = join(root, "operator-config"); await fs.mkdir(sentinel); await fs.writeFile(join(sentinel, "private"), "synthetic-private-marker");
      const result = await run(executable);
      expect(result.code).toBe(1); expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/^Administrative marketplace verification failed during [a-z-]+\. No session, model or service operation was requested\.\n$/);
      expect(result.stderr).not.toContain(root); expect(result.stderr).not.toContain("synthetic-private");
      expect(await fs.readFile(join(sentinel, "private"), "utf8")).toBe("synthetic-private-marker");
      const first = JSON.parse((await fs.readFile(log, "utf8")).split("\n")[0]!) as { tmp: string };
      await expect(fs.lstat(first.tmp)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it("rejects an exclusively-created root replaced by a symlink without chmod, writes or removal of foreign content", async () => {
    const { executable } = await fakeVendor("local"), foreign = join(root, "foreign");
    await fs.mkdir(foreign, { mode: 0o755 }); await fs.writeFile(join(foreign, "private"), "synthetic-private-marker");
    let substituted: string | undefined;
    vi.mocked(fs.mkdtemp).mockImplementation(async prefix => {
      const created = await original.mkdtemp(prefix);
      if (String(prefix).includes("spillway-marketplace-")) {
        substituted = created; await fs.rename(created, created + "-retained"); await fs.symlink(foreign, created);
      }
      return created;
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await smoke.runMarketplaceSmoke(["--claude", executable])).toBe(1);
    expect(stdout).not.toHaveBeenCalled(); expect(stderr).toHaveBeenCalled();
    expect((await fs.lstat(foreign)).mode & 0o777).toBe(0o755);
    expect(await fs.readFile(join(foreign, "private"), "utf8")).toBe("synthetic-private-marker");
    expect(await fs.readdir(foreign)).toEqual(["private"]);
    if (substituted) { await fs.unlink(substituted); await fs.rm(substituted + "-retained", { recursive: true }); }
  });
  it("kills an unref'ed same-group helper before successful administrative command resolution", async () => {
    const marker = join(root, "late-marker");
    const program = `const cp=require('node:child_process');cp.spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'late'),700)`)}],{stdio:'ignore'}).unref();console.log('ok');`;
    expect((await smoke.boundedCommand(process.execPath, ["-e", program], root, smoke.cleanEnvironment(root), 2000)).trim()).toBe("ok");
    await new Promise(done => setTimeout(done, 900));
    await expect(fs.lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
