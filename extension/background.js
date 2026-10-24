const BASE = "http://127.0.0.1:8787";
const API_KEY = "web-agents-to";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "chat") {
    fetch(BASE + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + API_KEY },
      body: JSON.stringify({ model: msg.model, messages: msg.messages, stream: false }),
    })
      .then((r) => r.json())
      .then((j) => sendResponse({ ok: true, data: j }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "models") {
    fetch(BASE + "/v1/models", { headers: { Authorization: "Bearer " + API_KEY } })
      .then((r) => r.json())
      .then((j) => sendResponse({ ok: true, data: j }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
});