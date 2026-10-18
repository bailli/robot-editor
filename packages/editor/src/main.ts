import { App } from "./app.ts";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("#app missing");
const app = new App(root);

if (import.meta.env.DEV) {
  // served by the dev server when reference/GameOfRobot.exe exists (vite.config.ts)
  const response = await fetch("/reference/GameOfRobot.exe");
  if (response.ok && response.headers.get("Content-Type") === "application/octet-stream") {
    app.load(new Uint8Array(await response.arrayBuffer()));
  }
}
