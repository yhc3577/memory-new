# @openclaw/memory-new

A new memory extension for OpenClaw.

## Installation

```bash
npm install @openclaw/memory-new
```

## Usage

After installation, add to your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "memory_new": {
        "enabled": true
      }
    }
  }
}
```

## Commands

- `memory_new status` - Show plugin status
- `memory_new help` - Show help

## Development

```bash
npm install
npm run build
npm publish
```

## License

MIT
