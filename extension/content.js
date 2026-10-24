// Floating chat panel on the provider site. All network access happens in the
// service worker, which owns the configurable base URL and API key.
(function () {
  if (window.__watInjected) return;
  window.__watInjected = true;

  const panel = document.createElement("div");
  panel.style.cssText = [
    "position:fixed",
    "bottom:16px",
    "right:16px",
    "width:320px",
    "background:#111",
    "color:#eee",
    "border:1px solid #333",
    "border-radius:8px",
    "padding:12px",
    "z-index:2147483647",
    "font-family:system-ui,sans-serif",
    "font-size:12px",
    "box-shadow:0 8px 30px rgba(0,0,0,.4)",
  ].join(";");

  const header = document.createElement("div");
  header.style.cssText = "display:flex;justify-content:space-between;align-items:center;font-weight:600;margin-bottom:8px;";
  header.textContent = "Web Agents To";

  const close = document.createElement("button");
  close.textContent = "×";
  close.title = "Hide panel";
  close.style.cssText = "background:none;border:none;color:#aaa;font-size:16px;cursor:pointer;";
  header.appendChild(close);

  const input = document.createElement("textarea");
  input.placeholder = "Ask your local agent...";
  input.style.cssText = "width:100%;box-sizing:border-box;height:60px;background:#222;color:#eee;border:1px solid #444;border-radius:4px;padding:6px;resize:vertical;";

  const send = document.createElement("button");
  send.textContent = "Send";
  send.style.cssText = "margin-top:6px;padding:4px 10px;background:#4f46e5;color:#fff;border:none;border-radius:4px;cursor:pointer;";

  const output = document.createElement("pre");
  output.style.cssText = "margin-top:8px;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-word;";

  panel.append(header, input, send, output);
  document.body.appendChild(panel);

  close.addEventListener("click", () => panel.remove());

  async function ask() {
    const text = input.value.trim();
    if (!text) return;

    send.disabled = true;
    send.textContent = "Thinking...";
    output.textContent = "";
    try {
      const response = await chrome.runtime.sendMessage({
        type: "chat",
        messages: [{ role: "user", content: text }],
      });
      if (response?.ok) {
        const content = response.data.content || "(empty response)";
        const tools = response.data.toolCalls ?? [];
        output.textContent = tools.length
          ? `${content}\n\nTool calls: ${tools.map((call) => call.function?.name).join(", ")}`
          : content;
      } else {
        output.textContent = `Error: ${response?.error ?? "unknown error"}`;
      }
    } catch (error) {
      output.textContent = `Error: ${error?.message ?? error}`;
    } finally {
      send.disabled = false;
      send.textContent = "Send";
    }
  }

  send.addEventListener("click", ask);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      ask();
    }
  });
})();
