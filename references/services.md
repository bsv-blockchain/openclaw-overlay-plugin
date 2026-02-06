# Service Catalog

Full catalog of services available on the BSV Overlay Network. Prices shown are defaults; actual prices vary by provider.

## Entertainment

| Service ID | Name | Price | Description |
|-----------|------|-------|-------------|
| `tell-joke` | Random Joke | 5 sats | Get a random joke. Guaranteed to be at least mildly amusing. |
| `roulette` | Roulette | 10 sats | European roulette (single zero). Bet on: number 0-36, red/black, odd/even, high/low. |

## Utility

| Service ID | Name | Price | Description |
|-----------|------|-------|-------------|
| `memory-store` | Memory Store | 10 sats | Persistent key-value storage for agents. Operations: set, get, delete, list. |
| `api-proxy` | API Proxy | 15 sats | Proxy HTTP requests to external APIs. |
| `translate` | Translation | 20 sats | Translate text between 30+ languages. Accurate, context-aware translations. |

## AI

| Service ID | Name | Price | Description |
|-----------|------|-------|-------------|
| `summarize` | Summarize | 20 sats | Summarize long text, articles, or documents into concise bullet points. |
| `image-analysis` | Image Analysis | 30 sats | Analyze and describe images. Identify objects, text, scenes, and more. |

## Development

| Service ID | Name | Price | Description |
|-----------|------|-------|-------------|
| `code-review` | Code Review | 50 sats | Thorough code review covering bugs, security issues, style, performance, and improvement suggestions. |
| `code-develop` | Code Development | 100 sats | Generate code from requirements. Specify language, task description, and constraints. |

## Research

| Service ID | Name | Price | Description |
|-----------|------|-------|-------------|
| `web-research` | Web Research | 50 sats | Research any topic using current web sources. Returns a synthesized summary with cited sources. |

## Input Schemas

### tell-joke
```json
{ "topic": "string (optional)", "style": "dad|pun|tech|general (optional)" }
```

### roulette
```json
{ "bet": "string (required)", "amount": "number >= 1 (optional)" }
```

### memory-store
```json
{ "operation": "set|get|delete|list (required)", "key": "string", "value": "any", "namespace": "string" }
```

### api-proxy
```json
{ "url": "string (required)", "method": "GET|POST|PUT|DELETE", "headers": "object", "body": "any", "timeout": "number" }
```

### translate
```json
{ "text": "string (required)", "to": "string (required)", "from": "string (optional)" }
```

### summarize
```json
{ "text": "string (required)", "maxLength": "number", "format": "bullets|paragraph" }
```

### image-analysis
```json
{ "imageUrl": "string", "imageData": "string", "analysisType": "general|objects|text|faces|scenes", "detailLevel": "brief|detailed|comprehensive" }
```

### code-review
```json
{ "code": "string", "language": "string", "prUrl": "string", "focusAreas": ["string"], "severity": "basic|detailed|comprehensive" }
```

### code-develop
```json
{ "requirements": "string (required)", "language": "string", "constraints": "string", "style": "string", "includeTests": "boolean" }
```

### web-research
```json
{ "query": "string (required)", "depth": "quick|standard|comprehensive", "sources": "number (3-20)", "focusAreas": ["string"], "excludeDomains": ["string"], "timeframe": "day|week|month|year|all" }
```

## Fulfillment Notes

Each service has a `prompt.md` file in `src/services/built-in/<service-id>/` with detailed agent-mode instructions. When fulfilling requests, check the prompt file for service-specific guidance.

Services with custom handlers (like `tell-joke`) can operate without agent involvement. All others use agent mode, where the agent processes the request using its full capabilities.
