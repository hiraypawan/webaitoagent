// Content script: injects a small floating panel to chat via the local API.
(function () {
  if (window.__watInjected) return;
  window.__watInjected = true;
  const panel = document.createElement("div");
  panel.style.cssText = "position:fixed;bottom:16px;right:16px;width:320px;background:#111;color:#eee;border:1px solid #333;border-radius:8px;padding:12px;z-index:999999;font-family:sans-serif;font-size:12px;";
  panel.innerHTML = `
    <div style="font-weight:bold;margin-bottom:8px;">Web Agents To</div>
    <textarea id="wat-input" style="width:100%;height:60px;background:#222;color:#eee;border:1px solid #444;border-radius:4px;"></textarea>
    <button id="wat-send" style="margin-top:6px;padding:4px 10px;background:#4f46e5;color:#fff;border:none;border-radius:4px;cursor:pointer;">Send</button>
    <pre id="wat-out" style="margin-top:8px;max-height:200px;overflow:auto;white-space:pre-wrap;"></pre>
  `;
  document.body.appendChild(panel);
  document.getElementById("wat-send").addEventListener("click", () => {
    const text = document.getElementById("wat-input").value;
    const out = document.getElementById("wat-out");
    out.textContent = "Thinking...";
    chrome.runtime.sendMessage({ type: "chat", model: "mimo/mimo-v2.6-pro", messages: [{ role: "user", content: text }] }, (resp) => {
      if (resp && resp.ok) {
        out.textContent = resp.data?.choices?.[0]?.message?.content ?? JSON.stringify(resp.data);
      } else {
        out.textContent = "Error: " + (resp?.error ?? "unknown");
      }
    });
  });
})();