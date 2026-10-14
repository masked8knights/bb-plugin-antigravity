// bb-plugin-antigravity — run bb threads on Google Antigravity.
//
// Self-registers the "antigravity" provider through the SDK provider API;
// turns are bridged by this plugin's host artifact, which shells out to the
// local `agy` CLI (`agy -p ... --output-format json`) per turn. No builtin
// provider-acp registration is involved.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { antigravityHostContract } from "./contract.js";

const OPTED_OUT_KEY = "optedOut";
const PROVIDER_ID = "antigravity";
const AGY_BINARY = "agy";
const BRIDGE_CONFIG_PATH = join(tmpdir(), "bb-plugin-antigravity", "config.json");

const statusSchema = z.object({
  providerId: z.string(),
  dataDir: z.string(),
  configPath: z.string(),
  enabled: z.boolean(),
  transport: z.string(),
  agyMissing: z.boolean(),
  adapterMissing: z.boolean(),
  adapterPath: z.string().optional(),
  pickerRegistered: z.boolean().optional(),
  drift: z.string().optional(),
  agy: z
    .object({
      path: z.string(),
      version: z.string().optional(),
      authState: z.enum(["ok", "failed", "unknown"]),
      modelCount: z.number().optional(),
      error: z.string().optional(),
    })
    .optional(),
});

export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: statusSchema },
  enable: {
    input: z.null(),
    output: z.object({
      ok: z.boolean(),
      message: z.string(),
      status: statusSchema.optional(),
    }),
  },
  disable: {
    input: z.null(),
    output: z.object({
      ok: z.boolean(),
      message: z.string(),
      status: statusSchema.optional(),
    }),
  },
});

function runNoStdin(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${bin} ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${bin} ${args.join(" ")} exited ${code}: ${stderr.slice(0, 400)}`));
    });
  });
}

/** Same candidate scan the old adapter path used: absolute override, PATH, then known install dirs. */
function findAgy(configured: string): string | undefined {
  const names = process.platform === "win32" ? ["agy.exe", "agy.cmd", "agy"] : ["agy"];
  const check = (dir: string): string | undefined => {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  };
  if (configured.trim()) {
    const raw = configured.trim();
    if (path.isAbsolute(raw)) {
      if (existsSync(raw)) return raw;
      if (process.platform === "win32" && existsSync(`${raw}.exe`)) return `${raw}.exe`;
      return undefined;
    }
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!dir) continue;
      const hit = check(dir);
      if (hit && path.basename(hit).toLowerCase().startsWith(AGY_BINARY)) return hit;
    }
  }
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const homes = [homedir(), process.env.HOME ?? homedir()];
  const dirs = [
    ...(localAppData ? [join(localAppData, "agy", "bin")] : []),
    ...homes.map((h) => join(h, ".local", "bin")),
    ...homes.map((h) => join(h, ".agy", "bin")),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of dirs) {
    const hit = check(dir);
    if (hit) return hit;
  }
  return undefined;
}

let modelProbe: { at: number; count: number } | null = null;

async function probeAgy(agyPath: string): Promise<{ version?: string; modelCount?: number; error?: string }> {
  let version: string | undefined;
  try {
    version = (await runNoStdin(agyPath, ["--version"], 10_000)).trim().split("\n")[0];
  } catch {
    version = undefined;
  }
  if (modelProbe && Date.now() - modelProbe.at < 5 * 60_000) {
    return { version, modelCount: modelProbe.count };
  }
  try {
    const stdout = await runNoStdin(agyPath, ["models"], 30_000);
    const count = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line.includes("\t")).length;
    modelProbe = { at: Date.now(), count };
    return { version, modelCount: count };
  } catch (error) {
    return { version, error: (error as Error).message };
  }
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    agyBin: {
      type: "string",
      label: "agy binary path",
      default: "",
      description: "Absolute path to the agy CLI. Empty auto-detects (PATH, %LOCALAPPDATA%\\agy\\bin, ~/.local/bin).",
    },
    model: {
      type: "string",
      label: "Default model id (blank = agy default)",
      default: "",
    },
    effort: {
      type: "select",
      label: "Default reasoning effort (only used when no specific model is picked)",
      options: ["low", "medium", "high"],
      default: "medium",
    },
  });

  const hostClient = bb.hosts.experimental_client({ contract: antigravityHostContract });

  function resolveAgyBin(configured: string): string {
    return findAgy(configured) ?? configured.trim() ?? AGY_BINARY;
  }

  async function pushConfigToHost(hostId: string, signal: AbortSignal): Promise<void> {
    const current = await settings.get();
    try {
      await hostClient.call(
        "setConfig",
        {
          agyBin: resolveAgyBin(current.agyBin),
          model: current.model,
          effort: current.effort as "low" | "medium" | "high",
        },
        { hostId, signal },
      );
    } catch {
      // A disconnect can race the connected-host snapshot; the reconciler
      // retries on the next request or host:changed event.
    }
  }

  let requestConfigReconcile = () => {};
  settings.onChange(() => {
    requestConfigReconcile();
  });

  bb.background.service("host-config-reconciler", {
    async start(signal) {
      let reconcileRequested = true;
      let wake: (() => void) | null = null;
      requestConfigReconcile = () => {
        reconcileRequested = true;
        wake?.();
      };
      const unsubscribeHost = bb.sdk.subscribe({
        event: "host:changed",
        callback: (event) => {
          if (event.changes.includes("host-connected")) requestConfigReconcile();
        },
      });
      try {
        while (!signal.aborted) {
          if (reconcileRequested) {
            reconcileRequested = false;
            const hosts = await bb.sdk.hosts.list({ signal });
            await Promise.all(
              hosts
                .filter((host) => host.status === "connected")
                .map((host) => pushConfigToHost(host.id, signal)),
            );
          }
          if (signal.aborted) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          wake = null;
        }
      } finally {
        requestConfigReconcile = () => {};
        unsubscribeHost();
      }
    },
  });

  let registration: { dispose(): void } | null = null;

  function registerProvider(): void {
    if (registration) return;
    registration = bb.providers.register({
      id: PROVIDER_ID,
      displayName: "Antigravity",
      icon: "./icons/antigravity.svg",
      models: { scope: "host" },
      capabilities: {
        supportsServiceTier: false,
        supportsNativeUserQuestion: false,
        fork: "none",
        supportsManualCompaction: false,
        supportsThreadArchive: false,
        supportsThreadRename: false,
        permissionModes: ["full"],
        // The model list is collapsed to one entry per model, so bb renders a
        // separate reasoning-effort picker (low/medium/high); the bridge
        // re-encodes the selection into the full agy model id at turn time.
        reasoningLevels: ["low", "medium", "high"],
      },
      composerActions: [],
    });
  }

  function unregisterProvider(): void {
    registration?.dispose();
    registration = null;
  }

  if (await bb.storage.kv.get<boolean>(OPTED_OUT_KEY)) {
    bb.log.info("provider registration skipped — disabled on purpose");
  } else {
    registerProvider();
  }

  async function currentStatus(): Promise<z.infer<typeof statusSchema>> {
    const current = await settings.get();
    const agyPath = findAgy(current.agyBin);
    let agy: z.infer<typeof statusSchema>["agy"];
    if (agyPath) {
      const probe = await probeAgy(agyPath);
      const authState =
        probe.modelCount !== undefined && probe.modelCount > 0
          ? "ok"
          : probe.error && /auth|login|unauthor/i.test(probe.error)
            ? "failed"
            : "unknown";
      agy = {
        path: agyPath,
        version: probe.version,
        authState,
        modelCount: probe.modelCount,
        error: probe.error,
      };
    }
    return {
      providerId: PROVIDER_ID,
      dataDir: path.dirname(BRIDGE_CONFIG_PATH),
      configPath: BRIDGE_CONFIG_PATH,
      enabled: registration !== null,
      transport: "agy -p json bridge",
      agyMissing: !agyPath,
      adapterMissing: false,
      pickerRegistered: registration !== null,
      agy,
    };
  }

  bb.rpc.register(rpcContract, {
    status: async () => currentStatus(),
    enable: async () => {
      await bb.storage.kv.delete(OPTED_OUT_KEY);
      registerProvider();
      requestConfigReconcile();
      return {
        ok: true,
        message: `${PROVIDER_ID} is registered by this plugin — it is in the provider picker.`,
        status: await currentStatus(),
      };
    },
    disable: async () => {
      await bb.storage.kv.set(OPTED_OUT_KEY, true);
      unregisterProvider();
      return {
        ok: true,
        message: `Unregistered ${PROVIDER_ID} from the provider picker (until re-enabled or reload).`,
        status: await currentStatus(),
      };
    },
  });

  bb.cli.register({
    name: "antigravity",
    summary: "Run bb threads on Google Antigravity via the self-registered provider bridge",
    commands: [
      {
        name: "status",
        summary: "Show whether the Antigravity provider is registered and agy is reachable",
        usage: "bb antigravity status [--json]",
      },
      {
        name: "doctor",
        summary: "Check the agy CLI, its subscription, and the bridge config",
        usage: "bb antigravity doctor [--json]",
      },
      {
        name: "enable",
        summary: "Register the Antigravity provider with bb",
        usage: "bb antigravity enable",
      },
      {
        name: "disable",
        summary: "Unregister the Antigravity provider from bb",
        usage: "bb antigravity disable",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const positional = argv.filter((arg) => !arg.startsWith("-"));
      const subcommand = positional[0] ?? "status";

      try {
        switch (subcommand) {
          case "status": {
            const status = await currentStatus();
            return json
              ? ok(JSON.stringify(status, null, 2))
              : ok(renderStatus(status));
          }
          case "doctor": {
            const status = await currentStatus();
            const lines = [renderStatus(status)];
            if (status.agy) {
              lines.push(`Bridge   ${existsSync(BRIDGE_CONFIG_PATH) ? BRIDGE_CONFIG_PATH : "config not pushed yet"}`);
            }
            return json ? ok(JSON.stringify(status, null, 2)) : ok(lines.join("\n"));
          }
          case "enable": {
            await bb.storage.kv.delete(OPTED_OUT_KEY);
            registerProvider();
            requestConfigReconcile();
            return ok(`${PROVIDER_ID} registered. Try:\n  bb thread spawn --provider ${PROVIDER_ID} --prompt "..."`);
          }
          case "disable": {
            await bb.storage.kv.set(OPTED_OUT_KEY, true);
            unregisterProvider();
            return ok(`Unregistered ${PROVIDER_ID}.`);
          }
          default:
            return {
              exitCode: 2,
              stderr:
                `Unknown subcommand "${subcommand}".\n` +
                "Usage: bb antigravity <status|doctor|enable|disable> [--json]\n",
            };
        }
      } catch (error) {
        return { exitCode: 1, stderr: `${(error as Error).message}\n` };
      }
    },
  });

  bb.agents.configure((context) => {
    if (context.provider.id !== PROVIDER_ID) {
      return { tools: [], skills: [] };
    }
    return {
      tools: [],
      skills: [],
      instructions:
        "You are running through ACP print-mode (`agy -p`). That process exits as soon as you yield. " +
        "Do not stop because a command, test, screenshot, or background task is still running. " +
        "Wait for it, then keep going until the user's original task is finished.\n\n" +
        "MANDATORY SKILL POLICY: Before executing ANY search, read, command, or file-edit tools, check the Available skills list. " +
        "If ANY skill matches the task domain (for example, UI/layout/mobile changes, antislop, unslop, bb CLI commands, workflows, or project conventions), " +
        "you MUST read its SKILL.md instructions using `view_file` at its absolute path as your very first tool call. " +
        "Do not skip reading the skill — do not write code or run search/edit tools without reading the governing skill first.",
    };
  });

  const initial = await settings.get();
  const agyPath = findAgy(initial.agyBin);
  if (!agyPath) {
    bb.status.needsConfiguration(
      `Missing ${AGY_BINARY} CLI. Install it with \`curl -fsSL https://antigravity.google/cli/install.sh | bash\`, then reload.`,
    );
  }
  bb.log.info(`ready (provider: ${PROVIDER_ID}, agy: ${agyPath ?? "missing"})`);

  bb.onDispose(() => {
    unregisterProvider();
    bb.log.info("disposed");
  });
}

function ok(stdout: string): { exitCode: number; stdout: string } {
  return { exitCode: 0, stdout: stdout.endsWith("\n") ? stdout : `${stdout}\n` };
}

function renderStatus(status: z.infer<typeof statusSchema>): string {
  const lines = [
    `Provider   ${status.providerId}  ${status.pickerRegistered ? "in picker" : "not in picker"}`,
    `Transport  ${status.transport}`,
    `Config     ${status.configPath}`,
  ];
  lines.push(
    status.agy
      ? `agy        ${status.agy.path}${status.agy.version ? ` (${status.agy.version})` : ""}` +
          `\n           ${renderAuth(status.agy)}`
      : `agy        MISSING — curl -fsSL https://antigravity.google/cli/install.sh | bash`,
  );
  return lines.join("\n");
}

function renderAuth(agy: NonNullable<z.infer<typeof statusSchema>["agy"]>): string {
  switch (agy.authState) {
    case "ok":
      return `subscription live, ${agy.modelCount} models`;
    case "failed":
      return `NOT authenticated${agy.error ? ` — ${agy.error}` : ""} — run \`agy\` once to log in`;
    default:
      return agy.error ? `models probe failed — ${agy.error}` : "models probe pending";
  }
}
