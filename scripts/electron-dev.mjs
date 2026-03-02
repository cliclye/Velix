import { spawn } from "node:child_process";
import http from "node:http";
import process from "node:process";

const NPM_BIN = process.platform === "win32" ? "npm.cmd" : "npm";
const HOST = process.env.VITE_DEV_HOST || "127.0.0.1";
const PORT = Number(process.env.VITE_DEV_PORT || 1420);
const DEV_SERVER_URL = `http://${HOST}:${PORT}`;

const waitForServer = (url, timeoutMs = 90_000) =>
  new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const req = http.get(url, (res) => {
        res.destroy();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }
        setTimeout(check, 300);
      });
      req.end();
    };
    check();
  });

const terminate = (child) => {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
};

const run = async () => {
  const vite = spawn(
    NPM_BIN,
    ["run", "dev", "--", "--host", HOST, "--port", String(PORT)],
    {
      stdio: "inherit",
      env: process.env,
    },
  );

  vite.on("exit", (code) => {
    if (code !== 0) {
      process.exitCode = code || 1;
    }
  });

  try {
    await waitForServer(DEV_SERVER_URL);
  } catch (error) {
    terminate(vite);
    throw error;
  }

  const electron = spawn(NPM_BIN, ["run", "electron"], {
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: DEV_SERVER_URL,
    },
  });

  const shutdown = () => {
    terminate(electron);
    terminate(vite);
  };

  process.on("SIGINT", () => {
    shutdown();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });

  electron.on("exit", (code) => {
    terminate(vite);
    process.exit(code || 0);
  });
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
