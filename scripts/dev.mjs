import { spawn } from "node:child_process";
import http from "node:http";

const vite = spawn("npx", ["vite", "--host", "127.0.0.1"], {
  stdio: "inherit",
  shell: true
});

let electron;

function waitForServer(url, attempts = 80) {
  return new Promise((resolve, reject) => {
    let count = 0;
    const tick = () => {
      count += 1;
      const request = http.get(url, (response) => {
        response.resume();
        resolve();
      });
      request.on("error", () => {
        if (count >= attempts) {
          reject(new Error(`Timed out waiting for ${url}`));
        } else {
          setTimeout(tick, 250);
        }
      });
    };
    tick();
  });
}

waitForServer("http://127.0.0.1:5173")
  .then(() => {
    electron = spawn("npx", ["electron", "."], {
      stdio: "inherit",
      shell: true,
      env: {
        ...process.env,
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173"
      }
    });

    electron.on("exit", (code) => {
      vite.kill();
      process.exit(code ?? 0);
    });
  })
  .catch((error) => {
    console.error(error);
    vite.kill();
    process.exit(1);
  });

process.on("SIGINT", () => {
  electron?.kill();
  vite.kill();
  process.exit(0);
});
