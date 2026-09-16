// Lightweight DuckDuckGo (lite HTML) scraper - no API key needed. Returns
// a handful of {title, url, snippet} results for the model to read and
// summarize; it never renders raw HTML to the user.

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim()
}

// Real destination is wrapped in DuckDuckGo's own redirect
// ("//duckduckgo.com/l/?uddg=<encoded-url>&rut=...") - unwrap it so the
// model gets (and can show) the actual site, not an extra redirect hop.
function unwrapRedirect(href) {
  try {
    const uddg = new URL(href, 'https://duckduckgo.com').searchParams.get('uddg')
    return uddg ? decodeURIComponent(uddg) : href
  } catch {
    return href
  }
}

export async function webSearch(query) {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } })
  if (!res.ok) throw new Error(`search returned ${res.status}`)
  const html = await res.text()

  // Attribute order/quoting in DuckDuckGo's markup isn't reliable enough
  // to match in one regex (href before class, single quotes) - grab each
  // whole <a> tag first, then pull href/class out of it separately.
  const links = []
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/g
  let m
  while ((m = anchorRe.exec(html))) {
    const [, attrs, inner] = m
    if (!/class=["']result-link["']/.test(attrs)) continue
    const hrefMatch = attrs.match(/href=["']([^"']+)["']/)
    if (!hrefMatch) continue
    links.push({ url: unwrapRedirect(hrefMatch[1]), title: stripTags(inner) })
  }

  const snippets = []
  const snippetRe = /<td[^>]*class=["']result-snippet["'][^>]*>([\s\S]*?)<\/td>/g
  while ((m = snippetRe.exec(html))) snippets.push(stripTags(m[1]))

  return links.slice(0, 5).map((link, i) => ({ ...link, snippet: snippets[i] || '' }))
}
