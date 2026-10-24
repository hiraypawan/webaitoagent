// Service worker: the only place that talks to the local API.
// Settings live in chrome.storage so no key is hardcoded in the extension.

const DEFAULTS = {
  baseUrl: "http://127.0.0.1:8787",
  apiKey: "web-agents-to",
  model: "mimo/mimo-v2.6-pro",
};

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return {
    baseUrl: String(stored.baseUrl || DEFAULTS.baseUrl).replace(/\/$/, ""),
    apiKey: String(stored.apiKey || DEFAULTS.apiKey),
    model: String(stored.model || DEFAULTS.model),
  };
}

async function api(path, init = {}, settings) {
  const config = settings ?? (await getSettings());
  const response = await fetch(config.baseUrl + path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const message = body?.error?.message ?? `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return body;
}

const handlers = {
  async chat(msg) {
    const settings = await getSettings();
    const data = await api(
      "/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: msg.model || settings.model,
          messages: msg.messages,
          stream: false,
        }),
      },
      settings
    );
    const choice = data?.choices?.[0]?.message;
    return {
      content: choice?.content ?? "",
      toolCalls: choice?.tool_calls ?? [],
    };
  },

  async models() {
    const data = await api("/v1/models");
    return { models: (data?.data ?? []).map((model) => model.id) };
  },

  async ping() {
    const settings = await getSettings();
    const response = await fetch(settings.baseUrl + "/health");
    if (!response.ok) throw new Error(`server returned ${response.status}`);
    return { health: await response.json(), settings };
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) {
    sendResponse({ ok: false, error: `unknown message type: ${message?.type}` });
    return false;
  }

  handler(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
  return true; // keep the channel open for the async response
});
