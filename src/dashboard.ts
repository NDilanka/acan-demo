import type { Link } from './store.ts';

const STYLE = `
  body { font: 15px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 56rem; padding: 0 1rem; color: #1b1b1f; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #ddd; vertical-align: top; }
  td.target { word-break: break-all; }
  td.clicks, th.clicks { text-align: right; font-variant-numeric: tabular-nums; }
  .empty { color: #666; }
`;

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Server-rendered page: one row per link with its click count. Every value is escaped. */
export function renderDashboard(username: string, links: Link[]): string {
  const totalClicks = links.reduce((sum, link) => sum + link.clicks, 0);
  const summary = `${links.length} link(s), ${totalClicks} click(s) in total`;

  const body =
    links.length === 0
      ? '<p class="empty">No links yet. Create one with POST /api/links.</p>'
      : `<table>
  <thead>
    <tr><th>Short link</th><th>Target</th><th class="clicks">Clicks</th><th>Created</th></tr>
  </thead>
  <tbody>
${links.map(renderRow).join('\n')}
  </tbody>
</table>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Links for ${escapeHtml(username)}</title>
  <style>${STYLE}</style>
</head>
<body>
  <h1>Links for ${escapeHtml(username)}</h1>
  <p>${escapeHtml(summary)}</p>
${body}
</body>
</html>
`;
}

function renderRow(link: Link): string {
  const code = escapeHtml(link.code);
  return `    <tr>
      <td><a href="/${code}">/${code}</a></td>
      <td class="target">${escapeHtml(link.target)}</td>
      <td class="clicks">${link.clicks}</td>
      <td>${escapeHtml(link.createdAt)}</td>
    </tr>`;
}
