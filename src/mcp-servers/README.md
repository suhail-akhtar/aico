# MCP (Model Context Protocol) Servers

Custom MCP servers for extending aico's capabilities beyond the base tooling system.

## 🌐 Web Search Server

**Purpose**: Search the internet for information and fetch webpage content

**Location**: `web-search-server.mjs`

### Features

- **Google Search** - Search Google for any topic (with fallback support)
- **DuckDuckGo Search** - Privacy-friendly search alternative
- **URL Fetching** - Fetch and extract content from any URL
- **HTML Parsing** - Automatically extract text from web pages
- **Redirect Following** - Handles HTTP redirects

### Available Tools

Once integrated, three tools become available:

#### 1. `mcp__web-search__google_search`
Search Google for information
```
Parameters:
  - query (string, required): Search query
  - num_results (number, optional): Number of results to return (default: 5)
```

#### 2. `mcp__web-search__fetch_url`
Fetch and extract content from a URL
```
Parameters:
  - url (string, required): URL to fetch
  - extract_text (boolean, optional): Extract main text content (default: true)
```

#### 3. `mcp__web-search__duckduckgo_search`
Search DuckDuckGo for information
```
Parameters:
  - query (string, required): Search query
```

## 🔧 Configuration

The MCP server is configured in `.claude/settings.json`:

```json
{
  "mcpServers": {
    "web-search": {
      "command": "node",
      "args": ["src/mcp-servers/web-search-server.mjs"],
      "type": "stdio"
    }
  }
}
```

## 🚀 Using the Web Search Server

### Example 1: Search for information
When you ask me something I don't know, I can automatically search for it:

```
User: What are the latest developments in quantum computing?
→ I'll use mcp__web-search__google_search to find current information
```

### Example 2: Fetch a specific URL
```
User: Get the content from https://example.com/article
→ I'll use mcp__web-search__fetch_url to retrieve and extract the content
```

### Example 3: Privacy-focused search
```
User: Search for privacy tools with DuckDuckGo
→ I'll use mcp__web-search__duckduckgo_search for privacy-friendly results
```

## 📋 Integration with aico

The MCP server is automatically loaded when aico starts if configured in `.claude/settings.json`.

**How it works**:
1. aico reads `.claude/settings.json` at startup
2. For each MCP server configured, it spawns the process via `node src/mcp-servers/web-search-server.mjs`
3. Tools from the server are discovered via the `tools/list` RPC method
4. Tools are prefixed with `mcp__<serverName>__<toolName>`
5. When I need to search the web, I call these tools automatically
6. Results are injected back into my context

## 🔑 API Keys (Optional)

For better Google Search results, you can provide a **SerpAPI key**:

1. Get a free API key from https://serpapi.com
2. Add to `.claude/settings.json`:
   ```json
   {
     "env": {
       "SERPAPI_KEY": "your_serpapi_key_here"
     }
   }
   ```

Without SerpAPI_KEY, Google Search uses a lightweight fallback approach (may be limited due to Google's rate limiting).

## 🛠️ Creating Custom MCP Servers

The protocol is simple JSON-RPC 2.0 over stdio. To create your own:

1. **Implement these methods**:
   - `initialize` - Server initialization
   - `tools/list` - List available tools
   - `tools/call` - Call a tool with arguments

2. **Example stub** (Node.js):
```javascript
import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const req = JSON.parse(line);
  
  if (req.method === 'initialize') {
    console.log(JSON.stringify({
      jsonrpc: '2.0', id: req.id,
      result: { serverInfo: { name: 'my-server', version: '1.0' } }
    }));
  } else if (req.method === 'tools/list') {
    console.log(JSON.stringify({
      jsonrpc: '2.0', id: req.id,
      result: { tools: [/* your tools */] }
    }));
  } else if (req.method === 'tools/call') {
    // Execute tool
    console.log(JSON.stringify({
      jsonrpc: '2.0', id: req.id,
      result: { content: [{ type: 'text', text: 'result' }] }
    }));
  }
});
```

3. **Add to `.claude/settings.json`**:
```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["src/mcp-servers/my-server.mjs"],
      "type": "stdio"
    }
  }
}
```

## 📚 Protocol Reference

### JSON-RPC 2.0 Messages

**Request Format**:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "google_search",
    "arguments": {
      "query": "what is rust",
      "num_results": 5
    }
  }
}
```

**Response Format**:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "search results..."
      }
    ]
  }
}
```

**Error Response**:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32603,
    "message": "Internal error",
    "data": "detailed error message"
  }
}
```

## 🧪 Testing the MCP Server

Run the web search server directly:

```bash
node src/mcp-servers/web-search-server.mjs
```

Then send JSON-RPC messages to stdin:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize"}' | node src/mcp-servers/web-search-server.mjs
echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node src/mcp-servers/web-search-server.mjs
```

## 📊 Architecture

```
User Query
    ↓
aico Agent
    ↓
Needs information not in context
    ↓
Calls mcp__web-search__google_search
    ↓
MCP Client in aico (src/mcp.ts)
    ↓
Spawns: node src/mcp-servers/web-search-server.mjs
    ↓
Server processes JSON-RPC request
    ↓
Fetches from Google / DuckDuckGo / URL
    ↓
Returns content to aico
    ↓
Claude processes results
    ↓
Answers user question with fresh information
```

## ✅ Status

- ✅ Web Search MCP Server created
- ✅ Integrated with aico `.claude/settings.json`
- ✅ Ready to use!

## 🎯 Next Steps

1. **Optional**: Add SERPAPI_KEY to `.claude/settings.json` for better Google Search
2. Start aico and ask questions - it will search the web automatically when needed
3. Create additional MCP servers for other capabilities (GitHub API, databases, etc.)

---

**Created**: 2026-04-08
**Protocol Version**: 2024-11-05 (MCP standard)
