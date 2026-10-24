const DEFAULTS = {
  baseUrl: "http://127.0.0.1:8787",
  apiKey: "web-agents-to",
  model: "mimo/mimo-v2.6-pro",
};

const $ = (id) => document.getElementById(id);

function setStatus(message, isError = false) {
  const status = $("status");
  status.textContent = message;
  status.classList.toggle("error", isError);
}

async function load() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  $("baseUrl").value = stored.baseUrl;
  $("apiKey").value = stored.apiKey;
  $("model").value = stored.model;
}

async function save() {
  const settings = {
    baseUrl: $("baseUrl").value.trim().replace(/\/$/, "") || DEFAULTS.baseUrl,
    apiKey: $("apiKey").value.trim() || DEFAULTS.apiKey,
    model: $("model").value.trim() || DEFAULTS.model,
  };
  if (!/^https?:\/\//.test(settings.baseUrl)) {
    setStatus("URL must start with http:// or https://", true);
    return;
  }
  await chrome.storage.local.set(settings);
  setStatus("Saved.");
  setTimeout(() => setStatus(""), 1500);
}

function send(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

$("save").addEventListener("click", () => {
  save().catch((error) => setStatus(String(error), true));
});

$("test").addEventListener("click", async () => {
  setStatus("Checking...");
  const response = await send({ type: "ping" });
  if (!response?.ok) {
    setStatus(response?.error ?? "no response", true);
    return;
  }
  const health = response.data.health;
  setStatus(`Connected (v${health.version ?? "?"}), providers: ${(health.providers ?? []).join(", ")}`);
  $("out").textContent = "";
});

$("models").addEventListener("click", async () => {
  setStatus("Loading models...");
  const response = await send({ type: "models" });
  if (!response?.ok) {
    setStatus(response?.error ?? "no response", true);
    return;
  }
  setStatus(`${response.data.models.length} model(s)`);
  $("out").textContent = response.data.models.join("\n");
});

load().catch((error) => setStatus(String(error), true));
