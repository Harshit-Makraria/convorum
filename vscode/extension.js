// Minimal VS Code integration: a status-bar unread counter and the room dashboard in a side panel.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

function config() {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) return null;
  const p = path.join(ws.uri.fsPath, '.convorum.json');
  if (!fs.existsSync(p)) return null;
  try { const c = JSON.parse(fs.readFileSync(p, 'utf8')); c.url = (c.url || 'http://localhost:7420').replace(/\/+$/, ''); return c; } catch { return null; }
}
const headers = (c) => ({ ...(c.token ? { authorization: `Bearer ${c.token}` } : {}), ...(c.key ? { 'x-room-key': c.key } : {}), ...(c.member_token ? { 'x-member-token': c.member_token } : {}) });

function activate(context) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.command = 'convorum.open';
  context.subscriptions.push(item);

  async function refresh() {
    const c = config();
    if (!c) { item.hide(); return; }
    try {
      const q = new URLSearchParams({ name: c.name, peek: '1' });
      const r = await fetch(`${c.url}/api/rooms/${encodeURIComponent(c.room)}/inbox?${q}`, { headers: headers(c) }).then((r) => r.json());
      const n = (r.messages || []).filter((m) => m.sender_kind !== 'system').length;
      const appr = await fetch(`${c.url}/api/rooms/${encodeURIComponent(c.room)}/approvals?status=pending`, { headers: headers(c) }).then((r) => r.json());
      const a = (appr.approvals || []).length;
      item.text = `$(comment-discussion) #${c.room}${n ? ` ${n}` : ''}${a ? ` $(warning) ${a}` : ''}`;
      item.tooltip = `Convorum: ${n} unread${r.mentions ? `, ${r.mentions} mention you` : ''}${a ? `, ${a} approval(s) pending` : ''}`;
    } catch { item.text = `$(debug-disconnect) #${c.room}`; item.tooltip = 'Convorum hub unreachable'; }
    item.show();
  }
  refresh();
  const t = setInterval(refresh, 20000);
  context.subscriptions.push({ dispose: () => clearInterval(t) });

  context.subscriptions.push(vscode.commands.registerCommand('convorum.open', () => {
    const c = config();
    if (!c) return vscode.window.showWarningMessage('No .convorum.json in this workspace. Run `npx convorum init` first.');
    const panel = vscode.window.createWebviewPanel('convorum', `#${c.room}`, vscode.ViewColumn.Beside, { enableScripts: true });
    const src = `${c.url}/r/${encodeURIComponent(c.room)}${c.key ? `?key=${encodeURIComponent(c.key)}` : ''}`;
    panel.webview.html = `<!doctype html><html><body style="margin:0;padding:0;height:100vh"><iframe src="${src}" style="border:0;width:100%;height:100%"></iframe></body></html>`;
  }));

  context.subscriptions.push(vscode.commands.registerCommand('convorum.digest', async () => {
    const c = config(); if (!c) return;
    const d = await fetch(`${c.url}/api/rooms/${encodeURIComponent(c.room)}/digest?name=${encodeURIComponent(c.name)}&hours=24`, { headers: headers(c) }).then((r) => r.json());
    const lines = [...(d.for_you || []), ...(d.decisions || []), ...(d.alerts || [])].map((x) => `${x.sender}: ${x.text}`);
    vscode.window.showInformationMessage(`Convorum #${c.room}: ${d.total} messages in 24h. ${lines.slice(0, 3).join(' | ') || 'Nothing urgent.'}`);
  }));
}
module.exports = { activate, deactivate() {} };
