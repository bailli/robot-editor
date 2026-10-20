import { App, type AppOptions } from "./app.ts";

const options: AppOptions = {};
if (import.meta.env.DEV) {
  // the development server runs the game under Wine (vite.config.ts)
  options.play = async (exe, episode) => {
    const response = await fetch(`/play?episode=${episode}`, {
      method: "POST",
      body: exe as BlobPart,
    });
    if (!response.ok) throw new Error(await response.text());
  };
}

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("#app missing");
const app = new App(root, options);

if (import.meta.env.DEV) {
  // served by the dev server when reference/GameOfRobot.exe exists (vite.config.ts)
  const response = await fetch("/reference/GameOfRobot.exe");
  if (response.ok && response.headers.get("Content-Type") === "application/octet-stream") {
    app.load(new Uint8Array(await response.arrayBuffer()));
  }
}
