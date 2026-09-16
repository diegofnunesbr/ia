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

export async function webSearch(query) {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } })
  if (!res.ok) throw new Error(`search returned ${res.status}`)
  const html = await res.text()

  const links = []
  const linkRe = /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  let m
  while ((m = linkRe.exec(html))) links.push({ url: m[1], title: stripTags(m[2]) })

  const snippets = []
  const snippetRe = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g
  while ((m = snippetRe.exec(html))) snippets.push(stripTags(m[1]))

  return links.slice(0, 5).map((link, i) => ({ ...link, snippet: snippets[i] || '' }))
}
