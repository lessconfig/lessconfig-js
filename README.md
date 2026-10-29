# LessConfig JavaScript SDK

JavaScript and TypeScript SDK for LessConfig. Access projects, environments and configurations, and receive configuration change notifications.

## Requirements

Node.js 18 or later, or a modern browser with ES2022, `fetch` and `AbortController` support.

## Installation

```shell
npm install lessconfig-js
```

ES modules, CommonJS and TypeScript declarations are included.

## Quick Start

For this Node.js example, set `LESSCONFIG_ENDPOINT` to your API root URL, such as `https://example.com/api`, and `LESSCONFIG_TOKEN` to your API token. The SDK adds the API version. Replace the project, environment and configuration key below with your own values.

```ts
import { createInterface } from 'node:readline/promises';
import { LessConfigClient } from 'lessconfig-js';

const client = new LessConfigClient({
    endpoint: process.env.LESSCONFIG_ENDPOINT!,
    token: process.env.LESSCONFIG_TOKEN!,
});
const terminal = createInterface({ input: process.stdin, output: process.stdout });

try {
    await client.addConfigListener('payment', 'prod', 'application.yml', async () => {
        const latest = await client.getConfig('payment', 'prod', 'application.yml');
        console.log(latest?.value ?? 'Configuration removed');
    });

    const config = await client.getConfig('payment', 'prod', 'application.yml');
    console.log(config?.value ?? 'Configuration not found');

    await terminal.question('Listening for changes. Press Enter to exit.\n');
} finally {
    client.close();
    terminal.close();
}
```

Configuration reads return promises. The first read loads and subscribes; subsequent reads return in-memory snapshots updated automatically in the background. Change listeners run after the affected cache has been refreshed. Call `close()` when the client is no longer needed.

## Build and Test

Use Node.js 24 to build and test the SDK.

```shell
npm ci
npm run check
```

Build output and TypeScript declarations are generated in `dist/`. Run `npm run check:package` for optional package installation and compatibility checks.

## License

Licensed under the [Apache License 2.0](LICENSE).
