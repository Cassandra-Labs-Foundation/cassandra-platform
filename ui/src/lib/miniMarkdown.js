// A deliberately small markdown renderer for the policy prose the compliance
// dashboard shows in place (General Policy Statement, a control's "why" and
// "how the system behaves"). Ported from the standalone dashboard's md() so
// the two render the same corpus identically.
//
// The corpus is prose with inline links, code spans, the odd list/table, and
// `§` citations. Everything is HTML-escaped BEFORE any markup is applied, so
// the transforms only ever add tags around already-escaped text — the output
// is safe to hand to dangerouslySetInnerHTML. Input is our own policy
// markdown, carried in the manifest; it never contains untrusted content.

export function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function mdInline(s) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, (_, c) => "<code>" + c + "</code>");
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => '<a href="' + u + '" target="_blank" rel="noopener">' + t + "</a>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return s;
}

function mdTable(lines) {
  const cells = (l) => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
  const head = cells(lines[0]).map((c) => "<th>" + mdInline(c) + "</th>").join("");
  const body = lines
    .slice(2)
    .map((l) => "<tr>" + cells(l).map((c) => "<td>" + mdInline(c) + "</td>").join("") + "</tr>")
    .join("");
  return '<div class="mdtable"><table><thead><tr>' + head + "</tr></thead><tbody>" + body + "</tbody></table></div>";
}

/** Render a markdown string to an HTML string (safe: escaped before markup). */
export function md(src) {
  if (!src) return "";
  const out = [];
  for (let block of String(src).replace(/\r/g, "").split(/\n{2,}/)) {
    block = block.trim();
    if (!block || /^---+$/.test(block)) continue; // bare rules are section joints
    const lines = block.split("\n");
    const h = block.match(/^(#{2,4})\s+(.*)$/);
    if (h && lines.length === 1) {
      const lvl = Math.min(h[1].length, 4);
      out.push("<h" + lvl + ">" + mdInline(h[2].replace(/\s*\{#.*\}\s*$/, "")) + "</h" + lvl + ">");
    } else if (lines.length >= 2 && /^\s*\|/.test(lines[0]) && /^[\s:|-]+$/.test(lines[1].replace(/\|/g, "|"))) {
      out.push(mdTable(lines));
    } else if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      out.push("<ul>" + lines.map((l) => "<li>" + mdInline(l.replace(/^\s*[-*]\s+/, "")) + "</li>").join("") + "</ul>");
    } else if (lines.every((l) => /^\s*\d+\.\s+/.test(l))) {
      out.push("<ol>" + lines.map((l) => "<li>" + mdInline(l.replace(/^\s*\d+\.\s+/, "")) + "</li>").join("") + "</ol>");
    } else if (lines.every((l) => /^\s*>\s?/.test(l))) {
      out.push("<blockquote>" + mdInline(lines.map((l) => l.replace(/^\s*>\s?/, "")).join(" ")) + "</blockquote>");
    } else {
      out.push("<p>" + mdInline(lines.join(" ")) + "</p>");
    }
  }
  return out.join("");
}
