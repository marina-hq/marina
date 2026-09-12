/** The local rendition of the gateway chrome: a badge that makes it
 * unmistakable this app is running on a laptop, as whom, and where bridged
 * calls go. Injected into HTML responses so app routing stays untouched. */

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function devChromeSnippet(input: { appName: string; userLabel: string }): string {
  return `<div id="__marina-dev-chrome" style="position:fixed;right:12px;bottom:12px;z-index:2147483647;display:flex;align-items:center;gap:8px;background:#121316;color:#e5e7ea;border:1px solid #2a2e34;border-radius:8px;padding:6px 12px;font:500 12px/1.4 ui-sans-serif,system-ui;box-shadow:0 4px 16px rgb(0 0 0 / 0.25)">
  <span style="width:8px;height:8px;border-radius:99px;background:#e0a24a"></span>
  <span>${escapeHtml(input.appName)} · local dev · ${escapeHtml(input.userLabel)}</span>
</div>`;
}

export function injectDevChrome(html: string, snippet: string): string {
  const marker = /<\/body\s*>/i.exec(html);
  if (!marker) return html + snippet;
  return html.slice(0, marker.index) + snippet + html.slice(marker.index);
}
