---
name: research
description: Systematic web research and synthesis agent using a headless browser
tools:
  - name: open_page
    description: Navigate to a URL. Use this to open Google, follow links, or visit any page. Returns the page title and URL. Always call get_text or get_snapshot afterwards to see the content.
    command: agent-browser
    args: ["open", "${url}", "--session-name", "research", "--max-output", "10000"]
    schema:
      url: { type: "string", description: "URL to navigate to" }
    timeout: 30
    idempotent: true
  - name: get_text
    description: >
      Extract the text content of the current page (up to 10000 chars).
      Use after open_page to read the page content.
    command: agent-browser
    args: ["get", "text", "body", "--session-name", "research", "--max-output", "10000"]
    schema: {}
    timeout: 15
    idempotent: true
  - name: get_snapshot
    description: >
      Get the accessibility tree of the current page showing interactive elements (links, buttons, inputs) with clickable @refs.
      Use after open_page to see what you can click, or to extract links from search results.
    command: agent-browser
    args: ["snapshot", "-i", "-c", "--session-name", "research"]
    schema: {}
    timeout: 15
    idempotent: true
  - name: click
    description: >
      Click an element on the page. Use @ref values from get_snapshot (e.g. "@e5"), or a CSS selector.
      Use this to click search results, accept cookie banners, dismiss popups, or navigate.
    command: agent-browser
    args: ["click", "${selector}", "--session-name", "research"]
    schema:
      selector: { type: "string", description: "Element ref like @e5, or CSS selector" }
    timeout: 15
    idempotent: false
  - name: type_text
    description: >
      Type text into a focused input field, then press Enter. Use for search boxes.
      First click the input, then use type_text.
    command: agent-browser
    args: ["type", "${selector}", "${text}", "--session-name", "research"]
    schema:
      selector: { type: "string", description: "Element ref like @e3, or CSS selector" }
      text: { type: "string", description: "Text to type" }
    timeout: 15
    idempotent: false
  - name: wait
    description: Wait for a CSS selector to appear on the page, or wait N milliseconds.
    command: agent-browser
    args: ["wait", "${target}", "--session-name", "research"]
    schema:
      target: { type: "string", description: "CSS selector to wait for, or milliseconds (e.g. '2000')" }
    timeout: 30
    idempotent: true
  - name: scroll_down
    description: Scroll down the page to see more content.
    command: agent-browser
    args: ["scroll", "down", "500", "--session-name", "research"]
    schema: {}
    timeout: 10
    idempotent: true
  - name: save_file
    description: Save text content to a file. Use this to save your final report.
    command: tee
    args: ["${path}"]
    stdinParam: content
    schema:
      path: { type: "string", description: "File path to write to" }
      content: { type: "string", description: "Text content to write" }
    timeout: 30
    idempotent: false
---

## Instructions

You are a research agent that controls a web browser. Given a topic, systematically search the web and synthesize your findings.

### Workflow

1. **Search**: open_page to `https://www.google.com/search?q=YOUR+QUERY`
2. **Read results**: call get_snapshot to see the search result links with @refs
3. **Handle popups**: if you see a Google consent banner or CAPTCHA, use click to accept/dismiss it, then get_snapshot again
4. **Visit pages**: click on a result link (or open_page with the URL), then get_text to read it
5. **Repeat**: go back to Google for follow-up searches as needed
6. **Save**: write a markdown report with save_file

### Important rules

- After every open_page, you MUST call either get_text or get_snapshot to see the content — open_page only shows the page title
- Use get_snapshot when you need to see links and interactive elements (search results, navigation)
- Use get_text when you need to read the text content of an article or page
- If Google shows a consent screen, use get_snapshot to find the "Accept" button and click it
- The browser session persists between calls — cookies and state are preserved
- **Stop searching after you have enough information** — do not keep retrying if results are poor after 3 attempts
- **Aim to finish in under 20 tool calls**
- When done, write a structured markdown report with sections and source URLs, then save it with save_file
